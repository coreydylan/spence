// Wave 7B Track B — PlanAgent nightly recompute logic, extracted as pure
// functions for unit testability.
//
// PlanAgent calls these from its alarm callback. The DO wraps them with state
// updates + tracing.

import type { MiseGraphEnv } from "../types";
import { loadActivePlan } from "../active-plans";
import { runHardCritics, runWarningCritics, type Grievance } from "../critics";
import { scorePlanCoherence } from "../coherence-score";
import { generateAgentId } from "./base";

export interface PlanHealthRow {
	id: string;
	plan_id: string;
	household_id: string | null;
	recorded_on: string;                   // YYYY-MM-DD
	coherence_score: number | null;
	hard_grievance_count: number;
	warning_grievance_count: number;
	issue_summary: HeadlineIssue[];
	created_at_ms: number;
	updated_at_ms: number;
}

export interface HeadlineIssue {
	severity: string;
	message: string;
	suggested_repair: string | null;
}

export interface RecomputePlanHealthOptions {
	now?: Date;
}

export interface RecomputeResult {
	row: PlanHealthRow;
	persisted: boolean;
	reason?: string;
}

/**
 * Pure: fold a plan into a PlanHealthRow. No D1 access — the DO is expected
 * to load the plan via loadActivePlan() and pass it in.
 */
export function buildPlanHealthRow(
	plan_id: string,
	household_id: string | null,
	plan: Parameters<typeof scorePlanCoherence>[0],
	now: Date = new Date(),
): PlanHealthRow {
	const recorded_on = now.toISOString().slice(0, 10);
	const created_at_ms = now.getTime();

	const hard = runHardCritics(plan, {});
	const warning = runWarningCritics(plan, { now: recorded_on });
	const score = scorePlanCoherence(plan);

	const headlines = headlineIssues([...hard, ...warning], 5);

	return {
		id: generateAgentId("ph"),
		plan_id,
		household_id,
		recorded_on,
		coherence_score: typeof score.score === "number" ? score.score : null,
		hard_grievance_count: hard.length,
		warning_grievance_count: warning.length,
		issue_summary: headlines,
		created_at_ms,
		updated_at_ms: created_at_ms,
	};
}

function headlineIssues(grievances: Grievance[], max: number): HeadlineIssue[] {
	const out: HeadlineIssue[] = [];
	for (const g of grievances) {
		out.push({
			severity: g.severity,
			message: g.message,
			suggested_repair: g.suggested_repair || null,
		});
		if (out.length >= max) break;
	}
	return out;
}

/**
 * Run recompute end-to-end: load plan, build row, persist, return.
 * If the plan can't be loaded the function returns persisted=false so the
 * caller (PlanAgent alarm) can decide whether to retry or just log.
 */
export async function recomputePlanHealth(
	env: MiseGraphEnv,
	plan_id: string,
	household_id: string | null,
	options: RecomputePlanHealthOptions = {},
): Promise<RecomputeResult> {
	const now = options.now || new Date();
	const plan = await loadActivePlan(env, plan_id);
	if (!plan) {
		return {
			row: {
				id: generateAgentId("ph"),
				plan_id,
				household_id,
				recorded_on: now.toISOString().slice(0, 10),
				coherence_score: null,
				hard_grievance_count: 0,
				warning_grievance_count: 0,
				issue_summary: [],
				created_at_ms: now.getTime(),
				updated_at_ms: now.getTime(),
			},
			persisted: false,
			reason: "plan_not_loaded",
		};
	}

	const row = buildPlanHealthRow(plan_id, household_id ?? plan.household_id ?? null, plan, now);
	await persistPlanHealthRow(env, row);
	return { row, persisted: true };
}

export async function persistPlanHealthRow(env: MiseGraphEnv, row: PlanHealthRow): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO mise_plan_health
			(id, plan_id, household_id, recorded_on,
			 coherence_score, hard_grievance_count, warning_grievance_count,
			 issue_summary_json, created_at_ms, updated_at_ms)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(plan_id, recorded_on) DO UPDATE SET
			coherence_score = excluded.coherence_score,
			hard_grievance_count = excluded.hard_grievance_count,
			warning_grievance_count = excluded.warning_grievance_count,
			issue_summary_json = excluded.issue_summary_json,
			updated_at_ms = excluded.updated_at_ms`,
	).bind(
		row.id,
		row.plan_id,
		row.household_id,
		row.recorded_on,
		row.coherence_score,
		row.hard_grievance_count,
		row.warning_grievance_count,
		JSON.stringify(row.issue_summary),
		row.created_at_ms,
		row.updated_at_ms,
	).run();
}

/** Schedule next recompute at +24h from `from`. Pure — caller wires alarm. */
export function nextRecomputeAt(from: Date = new Date()): Date {
	return new Date(from.getTime() + 24 * 60 * 60 * 1000);
}
