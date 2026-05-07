// Wave 7F — daily morning-brief cron runner.
//
// Wired into the Worker's `scheduled()` handler. The cron fires once per day
// at 14:00 UTC (= 7am Pacific) — see `wrangler.mise.toml` `[triggers]`.
//
// Sweep contract:
//   1. Enumerate every household with an active plan (or, when the
//      `mise_household_profiles` table has rows, every profiled household).
//   2. For each household, spawn its `HouseholdAgent` DO and POST
//      `/internal/daily-brief` with the per-household timezone.
//   3. Catch errors per-household so one bad row doesn't break the sweep.
//   4. Return a summary the worker logs to console.
//
// The actual brief composition + persistence runs INSIDE the DO so the
// per-household trace + decision log lines up with the rest of the
// HouseholdAgent's audit trail. This file just orchestrates the fan-out.

import type { Env } from "../mise-graph-worker";
import { householdAgentName } from "./agents/base";
import { listActivePlans } from "./active-plans";

// ─── Types ────────────────────────────────────────────────────────────────

export interface CronSweepResult {
	at: string;                                    // ISO timestamp the cron fired
	for_date: string;                              // YYYY-MM-DD the brief covers
	households_scanned: number;
	briefs_generated: number;
	skipped: Array<{ household_id: string; reason: string }>;
	errors: Array<{ household_id: string; error: string }>;
}

export interface HouseholdSweepRow {
	household_id: string;
	timezone: string;
}

const DEFAULT_TIMEZONE = "America/Los_Angeles";

// ─── Entry point ──────────────────────────────────────────────────────────

/**
 * The shape of "ask this household for its morning brief". Tests inject a
 * stub here that exercises `computeMorningBrief` + `persistMorningBrief`
 * directly (the Agents SDK doesn't boot in node), while production wires
 * the real DO bridge.
 */
export type HouseholdBriefInvoker = (
	household_id: string,
	timezone: string,
	for_date: string,
) => Promise<boolean>;

export interface DailyMorningBriefSweepOptions {
	invoke?: HouseholdBriefInvoker;
}

/**
 * Walk every active household and trigger its morning brief. Designed to be
 * called from the Worker's `scheduled()` handler — but also safe to call
 * from an admin route for testing.
 *
 * Errors per-household are collected into the result; one bad row will NEVER
 * abort the sweep.
 */
export async function runDailyMorningBriefSweep(
	env: Env,
	scheduledTime: number,
	options: DailyMorningBriefSweepOptions = {},
): Promise<CronSweepResult> {
	const at = new Date(scheduledTime).toISOString();
	const for_date = at.slice(0, 10);
	const result: CronSweepResult = {
		at,
		for_date,
		households_scanned: 0,
		briefs_generated: 0,
		skipped: [],
		errors: [],
	};

	let households: HouseholdSweepRow[] = [];
	try {
		households = await listSweepHouseholds(env);
	} catch (err) {
		result.errors.push({ household_id: "*", error: `listSweepHouseholds failed: ${errMsg(err)}` });
		return result;
	}

	const invoker: HouseholdBriefInvoker =
		options.invoke || ((hh, tz, fd) => invokeHouseholdDailyBrief(env, hh, tz, fd));

	for (const row of households) {
		result.households_scanned += 1;
		if (!row.household_id || typeof row.household_id !== "string") {
			result.skipped.push({ household_id: String(row.household_id || ""), reason: "malformed_row" });
			continue;
		}
		try {
			const ok = await invoker(row.household_id, row.timezone, for_date);
			if (ok) result.briefs_generated += 1;
			else result.skipped.push({ household_id: row.household_id, reason: "agent_returned_no_brief" });
		} catch (err) {
			result.errors.push({ household_id: row.household_id, error: errMsg(err) });
		}
	}

	return result;
}

// ─── Household enumeration ────────────────────────────────────────────────

/**
 * Return the list of households the sweep should process. Strategy:
 *   1. Pull distinct household_ids from `mise_household_profiles` (with their
 *      configured timezone, defaulting to America/Los_Angeles when null).
 *   2. Union with any household_ids that have active plans but no profile row
 *      — those households still deserve a brief; they just default tz.
 *
 * Both queries swallow errors and return [] so a missing table doesn't break
 * the sweep before it starts.
 */
export async function listSweepHouseholds(env: Env): Promise<HouseholdSweepRow[]> {
	const seen = new Map<string, HouseholdSweepRow>();

	// Profiles first — they carry the timezone column.
	try {
		const r = await env.DB.prepare(
			`SELECT household_id, timezone FROM mise_household_profiles
			 WHERE household_id IS NOT NULL AND household_id != ''`,
		).all<{ household_id: string; timezone: string | null }>();
		for (const row of r.results || []) {
			if (!row.household_id) continue;
			seen.set(row.household_id, {
				household_id: row.household_id,
				timezone: row.timezone || DEFAULT_TIMEZONE,
			});
		}
	} catch {
		// Profile table missing or column missing — fall through to active-plans.
	}

	// Active plans — covers households that have a plan but no profile row.
	try {
		const summaries = await listActivePlans(env);
		for (const s of summaries) {
			if (!s.household_id) continue;
			if (seen.has(s.household_id)) continue;
			seen.set(s.household_id, {
				household_id: s.household_id,
				timezone: DEFAULT_TIMEZONE,
			});
		}
	} catch {
		// noop — already covered by profiles, or both are missing.
	}

	return Array.from(seen.values());
}

// ─── DO invocation ────────────────────────────────────────────────────────

/**
 * Spawn the household's HouseholdAgent and POST /internal/daily-brief. The
 * agent computes + persists the brief and returns a summary. We treat any
 * 2xx with `ok: true` as a generated brief; everything else is a "skip" or
 * an error.
 */
async function invokeHouseholdDailyBrief(
	env: Env,
	household_id: string,
	timezone: string,
	for_date: string,
): Promise<boolean> {
	const ns = env.HOUSEHOLD_AGENT;
	if (!ns) throw new Error("HOUSEHOLD_AGENT binding missing");
	const stub = ns.get(ns.idFromName(householdAgentName(household_id)));

	// Init first — idempotent. Ensures the DO has its household_id set so the
	// /daily-brief route can run even on first encounter.
	try {
		await stub.fetch(
			new Request("https://agent/internal/init", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ household_id }),
			}),
		);
	} catch {
		// Init failure is non-fatal — the /daily-brief route falls back to
		// using its own state if it has one. If both are broken the brief
		// call below will surface the error.
	}

	const resp = await stub.fetch(
		new Request("https://agent/internal/daily-brief", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ for_date, timezone }),
		}),
	);
	const text = await resp.text();
	if (!resp.ok) {
		throw new Error(`HouseholdAgent /daily-brief returned ${resp.status}: ${text.slice(0, 256)}`);
	}
	const parsed = safeJson(text);
	return !!(parsed && parsed.ok === true);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function safeJson(text: string): { ok?: unknown; [k: string]: unknown } | null {
	try {
		const parsed = JSON.parse(text);
		return typeof parsed === "object" && parsed !== null
			? (parsed as { ok?: unknown; [k: string]: unknown })
			: null;
	} catch {
		return null;
	}
}
