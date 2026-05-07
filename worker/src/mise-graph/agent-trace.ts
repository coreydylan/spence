// Agent trace + replay debug (Wave 6).
//
// Every PlanWorld MCP tool call is wrapped in a trace context that captures:
//   - tool_name + tool_args (what the agent tried)
//   - tool_result + result_summary (what came back)
//   - duration_ms, ok, error (how it went)
//   - triggered_mutations (what got committed because of this call)
//   - caller_kind / caller_id (who issued it — agent/human/cron/replan/subagent)
//   - parent_trace_id (so nested calls keep a chain)
//
// WRITE tools also call linkMutationToTrace() so that when production asks
// "why was meal:sat_pizza committed?" we can walk from the meal_id back to
// the trace_id, then up the parent_trace_id chain to see the full reasoning
// path the agent took to land there.
//
// Trust contract: trace capture is best-effort but always attempted. A D1
// failure inside completeTrace() never prevents the underlying tool result
// from being returned — instead the failure is logged via console.warn and
// swallowed. The trace_id is still returned to callers so they can quote it
// in error reports even if D1 was momentarily unavailable.
//
// Schema: schema-agent-trace.sql (mise_agent_traces, mise_mutation_traces).

import type { MiseGraphEnv } from "./types";

// ─── Types ──────────────────────────────────────────────────────────────────

export type CallerKind = "agent" | "human" | "system" | "cron" | "replan" | "subagent";
export const VALID_CALLER_KINDS: ReadonlyArray<CallerKind> = [
	"agent",
	"human",
	"system",
	"cron",
	"replan",
	"subagent",
];

export interface TraceContext {
	trace_id: string;
	parent_trace_id: string | null;
	caller_kind: CallerKind;
	caller_id: string | null;
	household_id: string | null;
	plan_id: string | null;
	tool_name: string;
	tool_args: unknown;
	started_at: number;
}

export interface TriggeredMutation {
	kind: string;
	mutation_id: string;
}

export interface TraceCompletion {
	result_summary?: string;
	result?: unknown;
	ok?: boolean;
	error?: string;
	triggered_mutations?: TriggeredMutation[];
}

export interface TraceRow {
	trace_id: string;
	household_id: string | null;
	plan_id: string | null;
	parent_trace_id: string | null;
	tool_name: string;
	tool_args: unknown;
	tool_result: unknown | null;
	result_summary: string | null;
	caller_kind: string;
	caller_id: string | null;
	duration_ms: number;
	ok: boolean;
	error: string | null;
	triggered_mutations: TriggeredMutation[];
	created_at: string;
}

export interface MutationTraceRow {
	mutation_id: string;
	mutation_kind: string;
	plan_id: string;
	trace_id: string;
	committed_at: string;
}

// Agent traces and tool results can be very large (full plan snapshots, etc.).
// Truncate aggressively before persisting so D1 rows stay sub-32k. Replay
// queries return the truncated result alongside an `_truncated_to` field so
// callers can tell when they're looking at a partial blob.
const MAX_RESULT_BYTES = 32_000;
const MAX_ARGS_BYTES = 16_000;

// ─── Begin / complete ───────────────────────────────────────────────────────

export interface BeginTraceOpts {
	tool_name: string;
	tool_args: unknown;
	caller_kind: CallerKind;
	caller_id?: string;
	parent_trace_id?: string;
	household_id?: string;
	plan_id?: string;
}

/**
 * Open a trace for a single tool call. Returns a TraceContext you must pass
 * to completeTrace() (success or failure). The trace_id is generated up-front
 * so the handler can hand it to nested traced() calls (parent_trace_id) and
 * to linkMutationToTrace() if it commits a mutation.
 */
export function beginTrace(opts: BeginTraceOpts): TraceContext {
	return {
		trace_id: generateTraceId(),
		parent_trace_id: opts.parent_trace_id || null,
		caller_kind: opts.caller_kind,
		caller_id: opts.caller_id || null,
		household_id: opts.household_id || null,
		plan_id: opts.plan_id || null,
		tool_name: opts.tool_name,
		tool_args: opts.tool_args,
		started_at: Date.now(),
	};
}

/**
 * End the trace and persist to D1. Best-effort: a D1 error here never
 * propagates — the underlying tool already produced its result.
 */
export async function completeTrace(
	env: MiseGraphEnv,
	ctx: TraceContext,
	completion: TraceCompletion,
): Promise<{ trace_id: string }> {
	const duration_ms = Math.max(0, Date.now() - ctx.started_at);
	const ok = completion.ok !== false;
	const triggered = completion.triggered_mutations || [];

	const argsJson = truncateJson(ctx.tool_args, MAX_ARGS_BYTES);
	const resultJson = completion.result === undefined
		? null
		: truncateJson(completion.result, MAX_RESULT_BYTES);

	try {
		await env.DB.prepare(`
			INSERT INTO mise_agent_traces (
				trace_id, household_id, plan_id, parent_trace_id,
				tool_name, tool_args_json, tool_result_json, result_summary,
				caller_kind, caller_id,
				duration_ms, ok, error,
				triggered_mutations_json,
				created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).bind(
			ctx.trace_id,
			ctx.household_id,
			ctx.plan_id,
			ctx.parent_trace_id,
			ctx.tool_name,
			argsJson,
			resultJson,
			completion.result_summary || null,
			ctx.caller_kind,
			ctx.caller_id,
			duration_ms,
			ok ? 1 : 0,
			completion.error || null,
			JSON.stringify(triggered),
			new Date().toISOString(),
		).run();
	} catch (err) {
		// Never let trace persistence break the tool's response.
		console.warn(`[agent-trace] failed to persist trace ${ctx.trace_id}:`, err);
	}

	return { trace_id: ctx.trace_id };
}

// ─── Convenience wrapper ────────────────────────────────────────────────────

export interface TracedFnResult<T> {
	result: T;
	result_summary?: string;
	triggered_mutations?: TriggeredMutation[];
}

/**
 * Trace a function. If `fn` throws, the trace records error + ok=false and
 * the error is re-thrown to the caller. On success the wrapped result is
 * returned untouched.
 *
 * Pass `parent_trace_id` to nest traces (e.g. when an agent's subagent issues
 * a tool call inside a parent's evaluation step). The chain can be walked
 * back via getMutationTrace().
 */
export async function traced<T>(
	env: MiseGraphEnv,
	opts: BeginTraceOpts,
	fn: (ctx: TraceContext) => Promise<TracedFnResult<T>>,
): Promise<T> {
	const ctx = beginTrace(opts);
	try {
		const wrapped = await fn(ctx);
		await completeTrace(env, ctx, {
			result: wrapped.result,
			result_summary: wrapped.result_summary,
			ok: true,
			triggered_mutations: wrapped.triggered_mutations,
		});
		return wrapped.result;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await completeTrace(env, ctx, {
			ok: false,
			error: message,
			result_summary: `error: ${message.slice(0, 120)}`,
		});
		throw err;
	}
}

// ─── Mutation linkage ──────────────────────────────────────────────────────

export interface LinkMutationParams {
	mutation_id: string;
	mutation_kind: string;
	plan_id: string;
	trace_id: string;
}

/**
 * Link a committed mutation back to the trace that produced it. WRITE tool
 * handlers call this after `saveActivePlan()` succeeds. Idempotent on
 * mutation_id — re-running the same compose/split/etc. will overwrite the
 * pointer to the latest trace, which is the right behavior because the
 * latest trace is the one that explains the current state of the row.
 */
export async function linkMutationToTrace(
	env: MiseGraphEnv,
	params: LinkMutationParams,
): Promise<void> {
	if (!params.mutation_id || !params.trace_id || !params.plan_id) return;
	try {
		await env.DB.prepare(`
			INSERT OR REPLACE INTO mise_mutation_traces (
				mutation_id, mutation_kind, plan_id, trace_id, committed_at
			) VALUES (?, ?, ?, ?, ?)
		`).bind(
			params.mutation_id,
			params.mutation_kind,
			params.plan_id,
			params.trace_id,
			new Date().toISOString(),
		).run();
	} catch (err) {
		console.warn(`[agent-trace] failed to link mutation ${params.mutation_id}:`, err);
	}
}

// ─── Replay queries ────────────────────────────────────────────────────────

/**
 * Fetch a single trace row. Returns null if not found. The result + args
 * fields are JSON-parsed; if they're truncated, the parser still returns
 * a usable shape (the truncator wraps oversized payloads in
 * `{_truncated_to, preview}`).
 */
export async function getTrace(env: MiseGraphEnv, trace_id: string): Promise<TraceRow | null> {
	const row = await env.DB.prepare(`
		SELECT trace_id, household_id, plan_id, parent_trace_id,
			tool_name, tool_args_json, tool_result_json, result_summary,
			caller_kind, caller_id,
			duration_ms, ok, error,
			triggered_mutations_json,
			created_at
		FROM mise_agent_traces
		WHERE trace_id = ?
		LIMIT 1
	`).bind(trace_id).first<RawTraceRow>();
	return row ? hydrateTrace(row) : null;
}

/**
 * Reverse lookup: from a mutation_id (a meal id, batch id, etc.) get the
 * trace that committed it AND the chain of ancestor traces. Walks
 * parent_trace_id from leaf → root with a depth cap so a corrupt cycle
 * can't run away.
 */
export async function getMutationTrace(
	env: MiseGraphEnv,
	mutation_id: string,
): Promise<{ trace: TraceRow; ancestors: TraceRow[] } | null> {
	const link = await env.DB.prepare(`
		SELECT mutation_id, mutation_kind, plan_id, trace_id, committed_at
		FROM mise_mutation_traces
		WHERE mutation_id = ?
		LIMIT 1
	`).bind(mutation_id).first<MutationTraceRow>();
	if (!link) return null;

	const trace = await getTrace(env, link.trace_id);
	if (!trace) return null;

	const ancestors: TraceRow[] = [];
	const seen = new Set<string>([trace.trace_id]);
	let cursor: string | null = trace.parent_trace_id;
	let depth = 0;
	while (cursor && depth < 32) {
		if (seen.has(cursor)) break;  // cycle guard
		seen.add(cursor);
		const parent = await getTrace(env, cursor);
		if (!parent) break;
		ancestors.push(parent);
		cursor = parent.parent_trace_id;
		depth += 1;
	}
	return { trace, ancestors };
}

/**
 * Recent traces for a plan, newest first. Used by the replay UI to scroll
 * through "everything the agent did to this plan in the last hour".
 */
export async function listPlanTraces(
	env: MiseGraphEnv,
	plan_id: string,
	limit: number = 50,
): Promise<TraceRow[]> {
	const safeLimit = clampLimit(limit, 50, 500);
	const result = await env.DB.prepare(`
		SELECT trace_id, household_id, plan_id, parent_trace_id,
			tool_name, tool_args_json, tool_result_json, result_summary,
			caller_kind, caller_id,
			duration_ms, ok, error,
			triggered_mutations_json,
			created_at
		FROM mise_agent_traces
		WHERE plan_id = ?
		ORDER BY created_at DESC
		LIMIT ?
	`).bind(plan_id, safeLimit).all<RawTraceRow>();
	return (result.results || []).map(hydrateTrace);
}

/**
 * All committed mutations for a plan with their trace pointers. Used as the
 * index into a plan's history — caller picks a mutation_id and then calls
 * getMutationTrace to expand the reasoning chain.
 */
export async function listMutationsForPlan(
	env: MiseGraphEnv,
	plan_id: string,
	limit: number = 100,
): Promise<MutationTraceRow[]> {
	const safeLimit = clampLimit(limit, 100, 1000);
	const result = await env.DB.prepare(`
		SELECT mutation_id, mutation_kind, plan_id, trace_id, committed_at
		FROM mise_mutation_traces
		WHERE plan_id = ?
		ORDER BY committed_at DESC
		LIMIT ?
	`).bind(plan_id, safeLimit).all<MutationTraceRow>();
	return result.results || [];
}

// ─── Internals ──────────────────────────────────────────────────────────────

interface RawTraceRow {
	trace_id: string;
	household_id: string | null;
	plan_id: string | null;
	parent_trace_id: string | null;
	tool_name: string;
	tool_args_json: string;
	tool_result_json: string | null;
	result_summary: string | null;
	caller_kind: string;
	caller_id: string | null;
	duration_ms: number | null;
	ok: number | null;
	error: string | null;
	triggered_mutations_json: string | null;
	created_at: string;
}

function hydrateTrace(row: RawTraceRow): TraceRow {
	return {
		trace_id: row.trace_id,
		household_id: row.household_id,
		plan_id: row.plan_id,
		parent_trace_id: row.parent_trace_id,
		tool_name: row.tool_name,
		tool_args: parseJson(row.tool_args_json, null),
		tool_result: row.tool_result_json ? parseJson(row.tool_result_json, null) : null,
		result_summary: row.result_summary,
		caller_kind: row.caller_kind,
		caller_id: row.caller_id,
		duration_ms: typeof row.duration_ms === "number" ? row.duration_ms : 0,
		ok: row.ok === null || row.ok === undefined ? true : !!row.ok,
		error: row.error,
		triggered_mutations: row.triggered_mutations_json
			? (parseJson(row.triggered_mutations_json, []) as TriggeredMutation[])
			: [],
		created_at: row.created_at,
	};
}

/**
 * Coerce a CallerKind string from an HTTP header or arbitrary input. Falls
 * back to `system` so trace capture never fails on malformed callers.
 */
export function coerceCallerKind(value: unknown): CallerKind {
	if (typeof value !== "string") return "system";
	const lower = value.toLowerCase().trim();
	return (VALID_CALLER_KINDS as ReadonlyArray<string>).includes(lower)
		? (lower as CallerKind)
		: "system";
}

function generateTraceId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return `trace_${crypto.randomUUID()}`;
	}
	return `trace_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function truncateJson(value: unknown, maxBytes: number): string {
	let raw: string;
	try {
		raw = JSON.stringify(value);
	} catch {
		raw = JSON.stringify({ _unserializable: true, hint: String(value).slice(0, 200) });
	}
	if (raw === undefined) raw = "null";
	if (raw.length <= maxBytes) return raw;
	const preview = raw.slice(0, maxBytes - 64);
	return JSON.stringify({
		_truncated_to: maxBytes,
		_original_bytes: raw.length,
		preview,
	});
}

function parseJson(value: string, fallback: unknown): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return fallback;
	}
}

function clampLimit(limit: number, fallback: number, max: number): number {
	const n = Number.isFinite(limit) ? Math.floor(limit) : fallback;
	if (n < 1) return fallback;
	if (n > max) return max;
	return n;
}
