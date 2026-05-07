// Wave 7B Track B — CookAgent per-phase entry handlers as pure functions.
//
// Phase machine (see agents/base.ts COOK_TRANSITIONS):
//   planned → pre_session → active_session → completed
// Track B widens with `cancelled` exit available from non-terminal phases.
//
// CookAgent is intentionally minimal in Wave 7 — Wave 8 replaces it with an
// ephemeral CookingLeadAgent for brigade mode.

import type { MiseGraphEnv } from "../types";
import { type CookPhase } from "./base";

export type CookPhaseExt = CookPhase | "cancelled";

export const COOK_PHASES_EXT: ReadonlyArray<CookPhaseExt> = [
	"planned",
	"pre_session",
	"active_session",
	"completed",
	"cancelled",
];

export const COOK_TRANSITIONS_EXT: Record<CookPhaseExt, ReadonlyArray<CookPhaseExt>> = {
	planned: ["pre_session", "completed", "cancelled"],
	pre_session: ["active_session", "planned", "completed", "cancelled"],
	active_session: ["completed", "pre_session", "cancelled"],
	completed: [],
	cancelled: [],
};

export function isLegalCookTransition(from: CookPhaseExt, to: CookPhaseExt): boolean {
	const allowed = COOK_TRANSITIONS_EXT[from];
	if (!allowed) return false;
	return allowed.includes(to);
}

// ─── Alarm scheduling ──────────────────────────────────────────────────────

/**
 * Compute the alarm Date for the `pre_session` flip. Defaults to
 * `cook_window_start - 30min`. Caller (DO layer) owns the read of the
 * meal record from D1 because cook_window_start lives on the meal, not
 * the cook session.
 */
export function preSessionAlarmAt(cook_window_start_iso: string | null, now: Date = new Date()): Date | null {
	if (!cook_window_start_iso) return null;
	const ms = Date.parse(cook_window_start_iso);
	if (!Number.isFinite(ms)) return null;
	const target = new Date(ms - 30 * 60 * 1000);
	if (target.getTime() <= now.getTime()) {
		return new Date(now.getTime() + 60_000);
	}
	return target;
}

// ─── Feedback persistence ──────────────────────────────────────────────────

export interface FinishCookInput {
	cook_id: string;
	meal_id: string;
	household_id: string;
	plan_id?: string;
	rating?: number;
	notes?: string;
	now?: Date;
}

/**
 * Write a feedback row when a cook session finishes. Wraps the existing
 * `mise_meal_feedback` table directly because there isn't a writer helper
 * for the agent's specific shape (the existing recipe-feedback module also
 * writes to this table — we use the same schema).
 */
export async function recordCookFinish(env: MiseGraphEnv, input: FinishCookInput): Promise<{ feedback_id: string | null }> {
	const meal_id = (input.meal_id || "").trim();
	if (!meal_id) return { feedback_id: null };
	const now = (input.now || new Date()).toISOString();
	const id = `cook_finish_${input.cook_id}_${Date.now().toString(36)}`;

	try {
		await env.DB.prepare(
			`INSERT OR REPLACE INTO mise_meal_feedback
				(id, household_id, plan_id, meal_id, meal_date, meal_slot, meal_title,
				 meal_cuisine_json, meal_format, rating, would_repeat, finished, notes,
				 recorded_at, meta_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			id,
			input.household_id,
			input.plan_id ?? null,
			meal_id,
			null,
			null,
			null,
			"[]",
			null,
			typeof input.rating === "number" ? input.rating : null,
			null,
			1,
			input.notes ?? null,
			now,
			JSON.stringify({ source: "cook_agent", cook_id: input.cook_id }),
		).run();
	} catch (err) {
		// Feedback is best-effort — don't block phase transition.
		console.warn(`[cook-agent] failed to write meal_feedback for ${meal_id}:`, err);
		return { feedback_id: null };
	}

	return { feedback_id: id };
}

// ─── Phase entry decisions ─────────────────────────────────────────────────

export interface CookPhaseEntryDecision {
	phase: CookPhaseExt;
	next_alarm_at: Date | null;
	side_effect_kind: "schedule_pre_session" | "manual_only" | "completion" | "cancellation" | "none";
}

export function decideCookEntry(phase: CookPhaseExt, cook_window_start_iso: string | null, now: Date = new Date()): CookPhaseEntryDecision {
	switch (phase) {
		case "planned":
			return {
				phase,
				next_alarm_at: cook_window_start_iso ? preSessionAlarmAt(cook_window_start_iso, now) : null,
				side_effect_kind: "schedule_pre_session",
			};
		case "pre_session":
			return { phase, next_alarm_at: null, side_effect_kind: "manual_only" };
		case "active_session":
			return { phase, next_alarm_at: null, side_effect_kind: "manual_only" };
		case "completed":
			return { phase, next_alarm_at: null, side_effect_kind: "completion" };
		case "cancelled":
			return { phase, next_alarm_at: null, side_effect_kind: "cancellation" };
	}
}
