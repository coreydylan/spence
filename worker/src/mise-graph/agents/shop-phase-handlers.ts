// Wave 7B Track B — ShopAgent per-phase entry handlers as pure functions.
//
// Each handler returns the side-effects the DO should apply (state patches,
// next-alarm Date, D1 writes) so unit tests can assert on the decisions
// without booting the Agents SDK.
//
// Phase machine (see agents/base.ts SHOP_TRANSITIONS):
//   planned → active_today → completed
//   planned → cancelled
//   active_today → cancelled

import type { MiseGraphEnv } from "../types";
import { type ShopPhase } from "./base";
import { generateAgentId } from "./base";

// Track B widens the SHOP enum by one phase: `cancelled`. The base
// SHOP_TRANSITIONS map only knows about the happy path. Rather than mutating
// base.ts (foundation locked), we maintain an "extended" transition map
// here and the DO layer applies both checks. This keeps the existing test
// (u41) green and locks the Track B widening explicitly.
export type ShopPhaseExt = ShopPhase | "cancelled";

export const SHOP_PHASES_EXT: ReadonlyArray<ShopPhaseExt> = [
	"planned",
	"active_today",
	"completed",
	"cancelled",
];

export const SHOP_TRANSITIONS_EXT: Record<ShopPhaseExt, ReadonlyArray<ShopPhaseExt>> = {
	planned: ["active_today", "completed", "cancelled"],
	active_today: ["completed", "planned", "cancelled"],
	completed: [],
	cancelled: [],
};

export function isLegalShopTransition(from: ShopPhaseExt, to: ShopPhaseExt): boolean {
	const allowed = SHOP_TRANSITIONS_EXT[from];
	if (!allowed) return false;
	return allowed.includes(to);
}

// ─── Alarm scheduling ──────────────────────────────────────────────────────

/**
 * Compute the alarm Date for a shop run's `active_today` flip. We default
 * to 06:00 local on `run_date`. Wave 7B doesn't have lat/lng on the
 * household profile yet, so we pin to 13:00 UTC = 6am Pacific. Phase 2
 * wiring + a per-household tz column will refine this.
 */
export function activeTodayAlarmAt(run_date: string, now: Date = new Date()): Date | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(run_date)) return null;
	const ms = Date.parse(`${run_date}T13:00:00Z`);
	if (!Number.isFinite(ms)) return null;
	const target = new Date(ms);
	// If the supposed alarm time has already passed, fire ~immediately
	// (the DO's transitionTo will catch up and not double-fire because we
	// guard against re-entry on the phase enum).
	if (target.getTime() <= now.getTime()) {
		return new Date(now.getTime() + 60_000);
	}
	return target;
}

// ─── Reminder write ────────────────────────────────────────────────────────

export interface ShopReminderRow {
	id: string;
	shop_run_id: string;
	plan_id: string;
	run_date: string;
	fired_at_ms: number;
	payload_json: string | null;
	delivered: 0 | 1;
	delivered_at_ms: number | null;
	delivery_channel: string | null;
	created_at_ms: number;
	updated_at_ms: number;
}

export interface WriteShopReminderInput {
	shop_run_id: string;
	plan_id: string;
	run_date: string;
	payload?: Record<string, unknown>;
	now?: Date;
}

export function buildShopReminderRow(input: WriteShopReminderInput): ShopReminderRow {
	const now = (input.now || new Date()).getTime();
	return {
		id: generateAgentId("rem"),
		shop_run_id: input.shop_run_id,
		plan_id: input.plan_id,
		run_date: input.run_date,
		fired_at_ms: now,
		payload_json: input.payload ? JSON.stringify(input.payload) : null,
		delivered: 0,
		delivered_at_ms: null,
		delivery_channel: null,
		created_at_ms: now,
		updated_at_ms: now,
	};
}

export async function persistShopReminder(env: MiseGraphEnv, row: ShopReminderRow): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO mise_shop_reminders
			(id, shop_run_id, plan_id, run_date, fired_at_ms, payload_json,
			 delivered, delivered_at_ms, delivery_channel,
			 created_at_ms, updated_at_ms)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(shop_run_id, run_date) DO UPDATE SET
			fired_at_ms = excluded.fired_at_ms,
			payload_json = excluded.payload_json,
			updated_at_ms = excluded.updated_at_ms`,
	).bind(
		row.id,
		row.shop_run_id,
		row.plan_id,
		row.run_date,
		row.fired_at_ms,
		row.payload_json,
		row.delivered,
		row.delivered_at_ms,
		row.delivery_channel,
		row.created_at_ms,
		row.updated_at_ms,
	).run();
}

// ─── Phase entry decisions ─────────────────────────────────────────────────

export interface PhaseEntryDecision<P> {
	phase: P;
	next_alarm_at: Date | null;
	side_effect_kind: "shop_reminder" | "completion" | "cancellation" | "none";
}

export function decideShopEntry(phase: ShopPhaseExt, run_date: string | null, now: Date = new Date()): PhaseEntryDecision<ShopPhaseExt> {
	switch (phase) {
		case "planned":
			return {
				phase,
				next_alarm_at: run_date ? activeTodayAlarmAt(run_date, now) : null,
				side_effect_kind: "none",
			};
		case "active_today":
			return {
				phase,
				next_alarm_at: null,
				side_effect_kind: "shop_reminder",
			};
		case "completed":
			return {
				phase,
				next_alarm_at: null,
				side_effect_kind: "completion",
			};
		case "cancelled":
			return {
				phase,
				next_alarm_at: null,
				side_effect_kind: "cancellation",
			};
	}
}
