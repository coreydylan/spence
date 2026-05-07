// Member presence — per-person kitchen state.
//
// Brigade mode (Wave 8) needs to know which household members are
// available right now to take a task. Presence is a singleton row per
// member in `mise_member_presence`, updated by:
//   * the iOS / web client pinging when the user opens a cooking session
//     (state = "in_kitchen_idle" or "busy_assigned")
//   * the brigade scheduler flipping state to "busy_assigned" when it
//     hands a task to the member, back to "in_kitchen_idle" on completion
//   * a stale-timeout sweep flipping inactive members to "stepped_away"
//
// State machine
// -------------
//   absent              — not in the kitchen / no app open
//   in_kitchen_idle     — present, no task assigned (preferred for next pickup)
//   busy_assigned       — currently working on a task
//   stepped_away        — was here, hasn't pinged in a while
//
// "absent" vs "stepped_away" is a soft distinction — the lead chef can
// re-recruit either, but stepped_away is "they were here recently, try
// pinging them" while absent is "they're not in this cooking session."

import type { MiseGraphEnv } from "./types";

export type PresenceState = "absent" | "in_kitchen_idle" | "busy_assigned" | "stepped_away";

const VALID_STATES: ReadonlyArray<PresenceState> = ["absent", "in_kitchen_idle", "busy_assigned", "stepped_away"];

const DEFAULT_TIMEOUT_SEC = 300;  // 5 minutes

const PRESENCE_COLS = `member_id, state, current_task_id, current_session_id,
	last_ping_at, websocket_open, updated_at`;

export interface PresencePing {
	member_id: string;
	state: PresenceState;
	current_task_id?: string;
	current_session_id?: string;
	websocket_open?: boolean;
}

export interface PresenceSnapshot {
	state: PresenceState;
	current_task_id: string | null;
	last_ping_at: string | null;
	ms_since_ping: number;
}

export interface AvailableMember {
	member_id: string;
	display_name: string;
	presence: PresenceState;
}

interface PresenceRow {
	member_id: string;
	state: string;
	current_task_id: string | null;
	current_session_id: string | null;
	last_ping_at: string | null;
	websocket_open: number | null;
	updated_at: string;
}

export async function pingPresence(
	env: MiseGraphEnv,
	ping: PresencePing,
): Promise<void> {
	const member_id = (ping.member_id || "").trim();
	if (!member_id) throw new Error("pingPresence: member_id required");
	const state = normalizeState(ping.state);
	const now = new Date().toISOString();
	await env.DB.prepare(
		`INSERT OR REPLACE INTO mise_member_presence (${PRESENCE_COLS})
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).bind(
		member_id,
		state,
		ping.current_task_id ?? null,
		ping.current_session_id ?? null,
		now,
		ping.websocket_open ? 1 : 0,
		now,
	).run();
}

export async function getPresence(
	env: MiseGraphEnv,
	member_id: string,
): Promise<PresenceSnapshot> {
	const id = (member_id || "").trim();
	if (!id) {
		return { state: "absent", current_task_id: null, last_ping_at: null, ms_since_ping: Number.POSITIVE_INFINITY };
	}
	let row: PresenceRow | null = null;
	try {
		row = await env.DB.prepare(
			`SELECT ${PRESENCE_COLS} FROM mise_member_presence WHERE member_id = ?`,
		).bind(id).first<PresenceRow>();
	} catch {
		row = null;
	}
	if (!row) {
		return { state: "absent", current_task_id: null, last_ping_at: null, ms_since_ping: Number.POSITIVE_INFINITY };
	}
	return {
		state: normalizeState(row.state),
		current_task_id: row.current_task_id,
		last_ping_at: row.last_ping_at,
		ms_since_ping: row.last_ping_at ? Date.now() - Date.parse(row.last_ping_at) : Number.POSITIVE_INFINITY,
	};
}

export async function listAvailableMembers(
	env: MiseGraphEnv,
	household_id: string,
): Promise<AvailableMember[]> {
	const hh = (household_id || "").trim();
	if (!hh) return [];
	let memberRows: Array<{ member_id: string; display_name: string }> = [];
	try {
		const result = await env.DB.prepare(
			`SELECT member_id, display_name FROM mise_household_members
			 WHERE household_id = ?
			 ORDER BY created_at ASC`,
		).bind(hh).all<{ member_id: string; display_name: string }>();
		memberRows = (result.results || []) as Array<{ member_id: string; display_name: string }>;
	} catch {
		return [];
	}

	const out: AvailableMember[] = [];
	for (const m of memberRows) {
		const snap = await getPresence(env, m.member_id);
		if (snap.state === "in_kitchen_idle" || snap.state === "busy_assigned") {
			out.push({ member_id: m.member_id, display_name: m.display_name, presence: snap.state });
		}
	}
	// in_kitchen_idle preferred — sort idle first.
	out.sort((a, b) => {
		if (a.presence === b.presence) return 0;
		if (a.presence === "in_kitchen_idle") return -1;
		if (b.presence === "in_kitchen_idle") return 1;
		return 0;
	});
	return out;
}

export async function timeoutStalePresence(
	env: MiseGraphEnv,
	household_id: string,
	timeoutSec?: number,
): Promise<{ flipped_to_stepped_away: number }> {
	const hh = (household_id || "").trim();
	if (!hh) return { flipped_to_stepped_away: 0 };
	const timeout = Number.isFinite(timeoutSec) && (timeoutSec as number) > 0
		? Math.floor(timeoutSec as number)
		: DEFAULT_TIMEOUT_SEC;
	const cutoffMs = Date.now() - timeout * 1000;

	let memberRows: Array<{ member_id: string }> = [];
	try {
		const result = await env.DB.prepare(
			`SELECT member_id FROM mise_household_members
			 WHERE household_id = ?`,
		).bind(hh).all<{ member_id: string }>();
		memberRows = (result.results || []) as Array<{ member_id: string }>;
	} catch {
		return { flipped_to_stepped_away: 0 };
	}

	let flipped = 0;
	for (const m of memberRows) {
		const snap = await getPresenceRow(env, m.member_id);
		if (!snap) continue;
		if (snap.state === "stepped_away" || snap.state === "absent") continue;
		if (!snap.last_ping_at) continue;
		const pingedAt = Date.parse(snap.last_ping_at);
		if (!Number.isFinite(pingedAt)) continue;
		if (pingedAt >= cutoffMs) continue;
		await pingPresence(env, {
			member_id: m.member_id,
			state: "stepped_away",
			current_task_id: snap.current_task_id ?? undefined,
			current_session_id: snap.current_session_id ?? undefined,
		});
		// Restore last_ping_at to its original value so the user's
		// "last seen at" reading isn't reset by the timeout sweep.
		await env.DB.prepare(
			`UPDATE mise_member_presence
			    SET last_ping_at = ?
			  WHERE member_id = ?`,
		).bind(snap.last_ping_at, m.member_id).run();
		flipped++;
	}

	return { flipped_to_stepped_away: flipped };
}

async function getPresenceRow(
	env: MiseGraphEnv,
	member_id: string,
): Promise<{
	state: PresenceState;
	current_task_id: string | null;
	current_session_id: string | null;
	last_ping_at: string | null;
} | null> {
	let row: PresenceRow | null = null;
	try {
		row = await env.DB.prepare(
			`SELECT ${PRESENCE_COLS} FROM mise_member_presence WHERE member_id = ?`,
		).bind(member_id).first<PresenceRow>();
	} catch {
		return null;
	}
	if (!row) return null;
	return {
		state: normalizeState(row.state),
		current_task_id: row.current_task_id,
		current_session_id: row.current_session_id,
		last_ping_at: row.last_ping_at,
	};
}

function normalizeState(value: unknown): PresenceState {
	if (typeof value !== "string") return "absent";
	const v = value.trim().toLowerCase();
	if (VALID_STATES.includes(v as PresenceState)) return v as PresenceState;
	return "absent";
}
