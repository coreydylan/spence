// D1-backed plan persistence shared by the PlanWorld MCP tool server.
//
// MCP tool calls run as independent HTTP requests, so the in-memory
// RipplePreview proposal cache and any composer-side state is dropped
// between turns. Plans themselves still need to persist across turns,
// hence this thin save/load module against a dedicated `mise_active_plans`
// table. Schema lives in schema-active-plans.sql; the integrator wave is
// responsible for actually applying it.

import type { MiseGraphEnv } from "./types";
import type { MiseWeeklyPlanDraft } from "./planner";

export interface ActivePlanSummary {
	plan_id: string;
	household_id: string | null;
	status: string;
	updated_at: string;
}

/**
 * Persist (or overwrite) the active plan row for `plan.id`. Idempotent —
 * tool handlers call this on every mutation so the next turn picks up the
 * latest snapshot.
 */
export async function saveActivePlan(env: MiseGraphEnv, plan: MiseWeeklyPlanDraft): Promise<void> {
	const status = (plan as { status?: string }).status || "draft";
	await env.DB.prepare(`
		INSERT INTO mise_active_plans (plan_id, household_id, plan_json, status, created_at, updated_at)
		VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
		ON CONFLICT(plan_id) DO UPDATE SET
			household_id = excluded.household_id,
			plan_json    = excluded.plan_json,
			status       = excluded.status,
			updated_at   = datetime('now')
	`).bind(
		plan.id,
		plan.household_id || null,
		JSON.stringify(plan),
		status,
	).run();
}

/**
 * Load the active plan by id. Returns null when not found or unparseable —
 * callers handle missing rows by surfacing a tool error rather than throwing.
 */
export async function loadActivePlan(env: MiseGraphEnv, plan_id: string): Promise<MiseWeeklyPlanDraft | null> {
	const row = await env.DB.prepare(
		"SELECT plan_json FROM mise_active_plans WHERE plan_id = ? LIMIT 1",
	).bind(plan_id).first<{ plan_json: string }>();
	if (!row?.plan_json) return null;
	try {
		return JSON.parse(row.plan_json) as MiseWeeklyPlanDraft;
	} catch {
		return null;
	}
}

/**
 * Remove an active plan from the working set. Used by `plan_archive`.
 */
export async function deleteActivePlan(env: MiseGraphEnv, plan_id: string): Promise<void> {
	await env.DB.prepare("DELETE FROM mise_active_plans WHERE plan_id = ?")
		.bind(plan_id)
		.run();
}

/**
 * List active plans, optionally scoped to a household. Returns metadata only;
 * callers should `loadActivePlan` for full plan JSON.
 */
export async function listActivePlans(
	env: MiseGraphEnv,
	household_id?: string,
): Promise<ActivePlanSummary[]> {
	const sql = household_id
		? "SELECT plan_id, household_id, status, updated_at FROM mise_active_plans WHERE household_id = ? ORDER BY updated_at DESC LIMIT 100"
		: "SELECT plan_id, household_id, status, updated_at FROM mise_active_plans ORDER BY updated_at DESC LIMIT 100";
	const stmt = household_id
		? env.DB.prepare(sql).bind(household_id)
		: env.DB.prepare(sql);
	const result = await stmt.all<{
		plan_id: string;
		household_id: string | null;
		status: string | null;
		updated_at: string | null;
	}>();
	return (result.results || []).map(row => ({
		plan_id: row.plan_id,
		household_id: row.household_id || null,
		status: row.status || "draft",
		updated_at: row.updated_at || "",
	}));
}

/**
 * Mark an active plan as `final`. The plan_json keeps the latest meals/critic
 * state; status flips so consumers can stop offering it as a working draft.
 */
export async function markActivePlanFinal(env: MiseGraphEnv, plan_id: string, plan: MiseWeeklyPlanDraft): Promise<void> {
	const finalPlan: MiseWeeklyPlanDraft = { ...plan, status: "draft" };
	// We keep `status` on the row at "final" but the in-JSON status remains a
	// MiseWeeklyPlanDraft-compatible literal so downstream code stays typed.
	await env.DB.prepare(`
		INSERT INTO mise_active_plans (plan_id, household_id, plan_json, status, created_at, updated_at)
		VALUES (?, ?, ?, 'final', datetime('now'), datetime('now'))
		ON CONFLICT(plan_id) DO UPDATE SET
			plan_json  = excluded.plan_json,
			status     = 'final',
			updated_at = datetime('now')
	`).bind(
		plan_id,
		finalPlan.household_id || null,
		JSON.stringify(finalPlan),
	).run();
}
