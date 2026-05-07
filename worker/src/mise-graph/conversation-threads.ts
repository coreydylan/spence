// Conversation threads — multi-turn agent context across requests.
//
// The chef-of-staff agent doesn't run as a single long-lived process; each
// API call is independent. Threads give the agent a place to persist
// "what we were just talking about": the topic, the working state, the
// plan it was operating on, the count of turns so far. When a new request
// comes in, the agent can call `getActiveThreadFor(household, topic)` to
// resume, or `startThread` to begin a fresh one.
//
// Storage lives in `mise_conversation_threads` (see schema-household-memory.sql).
//
// Design notes
// ------------
// * `state_json` is intentionally a free-form bag the agent owns. The
//   shape is up to the caller; we just merge top-level patches.
// * "Active" = closed_at IS NULL. `getActiveThreadFor` returns the most
//   recent open thread for the household + topic combo.
// * Closing a thread doesn't delete it; we keep the row so `listRecentThreads`
//   can still surface it for human inspection.

import type { MiseGraphEnv } from "./types";

export interface ConversationThread {
	thread_id: string;
	household_id: string;
	topic: string | null;
	state: Record<string, unknown>;
	active_plan_id: string | null;
	last_turn_at: string;
	closed_at: string | null;
	message_count: number;
}

export interface StartThreadParams {
	household_id: string;
	topic?: string;
	active_plan_id?: string;
	thread_id?: string;
}

interface ThreadRow {
	thread_id: string;
	household_id: string;
	topic: string | null;
	state_json: string | null;
	active_plan_id: string | null;
	last_turn_at: string;
	closed_at: string | null;
	message_count: number;
}

export async function startThread(
	env: MiseGraphEnv,
	params: StartThreadParams,
): Promise<ConversationThread> {
	const hh = (params.household_id || "").trim();
	if (!hh) throw new Error("startThread: household_id required");
	const now = new Date().toISOString();
	const topic = params.topic ? params.topic.trim() : null;
	const thread_id = (params.thread_id && params.thread_id.trim()) || generateThreadId(hh, topic, now);

	const thread: ConversationThread = {
		thread_id,
		household_id: hh,
		topic,
		state: {},
		active_plan_id: params.active_plan_id ? params.active_plan_id.trim() : null,
		last_turn_at: now,
		closed_at: null,
		message_count: 0,
	};

	await env.DB.prepare(
		`INSERT OR REPLACE INTO mise_conversation_threads
			(thread_id, household_id, topic, state_json, active_plan_id,
			 last_turn_at, closed_at, message_count)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			thread.thread_id,
			thread.household_id,
			thread.topic,
			JSON.stringify(thread.state),
			thread.active_plan_id,
			thread.last_turn_at,
			thread.closed_at,
			thread.message_count,
		)
		.run();

	return thread;
}

export async function getThread(
	env: MiseGraphEnv,
	thread_id: string,
): Promise<ConversationThread | null> {
	const id = (thread_id || "").trim();
	if (!id) return null;
	let row: ThreadRow | null = null;
	try {
		row = await env.DB.prepare(
			`SELECT thread_id, household_id, topic, state_json,
			        active_plan_id, last_turn_at, closed_at, message_count
			 FROM mise_conversation_threads
			 WHERE thread_id = ?`,
		).bind(id).first<ThreadRow>();
	} catch {
		return null;
	}
	return row ? rowToThread(row) : null;
}

export async function getActiveThreadFor(
	env: MiseGraphEnv,
	household_id: string,
	topic: string,
): Promise<ConversationThread | null> {
	const hh = (household_id || "").trim();
	const t = (topic || "").trim();
	if (!hh || !t) return null;
	let row: ThreadRow | null = null;
	try {
		row = await env.DB.prepare(
			`SELECT thread_id, household_id, topic, state_json,
			        active_plan_id, last_turn_at, closed_at, message_count
			 FROM mise_conversation_threads
			 WHERE household_id = ?
			   AND topic = ?
			   AND closed_at IS NULL
			 ORDER BY last_turn_at DESC
			 LIMIT 1`,
		).bind(hh, t).first<ThreadRow>();
	} catch {
		return null;
	}
	return row ? rowToThread(row) : null;
}

export async function updateThreadState(
	env: MiseGraphEnv,
	thread_id: string,
	state_patch: Record<string, unknown>,
): Promise<ConversationThread> {
	const id = (thread_id || "").trim();
	if (!id) throw new Error("updateThreadState: thread_id required");
	const existing = await getThread(env, id);
	if (!existing) throw new Error(`updateThreadState: thread ${id} not found`);

	const merged: Record<string, unknown> = {
		...(existing.state || {}),
		...(state_patch || {}),
	};
	const now = new Date().toISOString();
	const next: ConversationThread = {
		...existing,
		state: merged,
		last_turn_at: now,
		message_count: existing.message_count + 1,
	};

	await env.DB.prepare(
		`UPDATE mise_conversation_threads
		    SET state_json = ?,
		        last_turn_at = ?,
		        message_count = ?
		  WHERE thread_id = ?`,
	)
		.bind(
			JSON.stringify(next.state),
			next.last_turn_at,
			next.message_count,
			next.thread_id,
		)
		.run();

	return next;
}

export async function closeThread(env: MiseGraphEnv, thread_id: string): Promise<void> {
	const id = (thread_id || "").trim();
	if (!id) return;
	const now = new Date().toISOString();
	await env.DB.prepare(
		`UPDATE mise_conversation_threads
		    SET closed_at = ?
		  WHERE thread_id = ?`,
	).bind(now, id).run();
}

export async function listRecentThreads(
	env: MiseGraphEnv,
	household_id: string,
	limit?: number,
): Promise<ConversationThread[]> {
	const hh = (household_id || "").trim();
	if (!hh) return [];
	const cap = clampPositiveInt(limit, 20);
	let rows: ThreadRow[] = [];
	try {
		const result = await env.DB.prepare(
			`SELECT thread_id, household_id, topic, state_json,
			        active_plan_id, last_turn_at, closed_at, message_count
			 FROM mise_conversation_threads
			 WHERE household_id = ?
			 ORDER BY last_turn_at DESC
			 LIMIT ?`,
		).bind(hh, cap).all<ThreadRow>();
		rows = (result.results || []) as ThreadRow[];
	} catch {
		return [];
	}
	return rows.map(rowToThread);
}

// ---------- helpers ----------

function rowToThread(row: ThreadRow): ConversationThread {
	return {
		thread_id: row.thread_id,
		household_id: row.household_id,
		topic: row.topic,
		state: parseStateJson(row.state_json),
		active_plan_id: row.active_plan_id,
		last_turn_at: row.last_turn_at,
		closed_at: row.closed_at,
		message_count: typeof row.message_count === "number" ? row.message_count : 0,
	};
}

function parseStateJson(value: string | null | undefined): Record<string, unknown> {
	if (!value || typeof value !== "string") return {};
	try {
		const parsed = JSON.parse(value);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as Record<string, unknown>;
	} catch {
		return {};
	}
}

function clampPositiveInt(v: unknown, fallback: number): number {
	const n = typeof v === "number" ? v : Number(v);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.min(Math.floor(n), 200);
}

function generateThreadId(household_id: string, topic: string | null, isoTime: string): string {
	const slug = topic ? topic.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32) : "thread";
	const stamp = isoTime.replace(/[^0-9]/g, "").slice(0, 14);
	const rand = Math.random().toString(36).slice(2, 8);
	return `thr_${household_id}__${slug}__${stamp}_${rand}`;
}
