// Wave 7 foundation — shared conventions for the 6 entity Durable Objects.
//
// This module is the "constitution" every entity DO imports from. It defines:
//   1. The DO id format for each agent type (so callers can compute `idFromName`
//      consistently across the codebase).
//   2. The MealAgent state-machine phase enum + legal transition guard map.
//      Wave 7B will plug real entry/exit logic in; this file just holds the
//      shape so the skeletons compile and tests can lock the contract.
//   3. A best-effort alarm scheduler helper (`scheduleNextAlarm`) so each DO
//      uses the same shape when it asks the runtime to wake it later.
//   4. Module augmentation that makes our worker's `Env` interface visible to
//      the Agents SDK as `Cloudflare.Env`.
//
// IMPORTANT: keep this file thin. State-machine BEHAVIOUR (entry/exit
// callbacks, what to do during `pre_eve`, etc.) lives in Wave 7B. This file is
// the type-level contract.

import type { MiseGraphEnv } from "../types";

// ─── Module augmentation ────────────────────────────────────────────────────
//
// Cloudflare's Agents SDK constrains its `Env` generic to `Cloudflare.Env`.
// `@cloudflare/workers-types` declares `namespace Cloudflare { interface Env
// {} }` as an empty interface, which projects are expected to merge into.
// We augment it with our existing MiseGraphEnv so every Agent subclass can
// be parameterised with `Env` — and so Worker handlers that already use
// `MiseGraphEnv` can continue to do so without diverging.

declare global {
	namespace Cloudflare {
		interface Env extends MiseGraphEnv {
			HOUSEHOLD_AGENT: DurableObjectNamespace;
			PLAN_AGENT: DurableObjectNamespace;
			MEAL_AGENT: DurableObjectNamespace;
			SHOP_AGENT: DurableObjectNamespace;
			COOK_AGENT: DurableObjectNamespace;
			MEMBER_AGENT: DurableObjectNamespace;
			// Wave 8 foundation — ephemeral brigade lead per cook session.
			// Optional so handlers running with a Wave 7-only env still type-check.
			COOKING_LEAD_AGENT?: DurableObjectNamespace;
			// Wave 8B Track B — brigade photo storage (R2). Optional so the same
			// type compiles before the bucket is provisioned; the photo route
			// returns 503 when missing.
			BRIGADE_PHOTOS?: R2Bucket;
		}
	}
}

// Project-facing alias. Worker handlers and DO subclasses reference this; it
// flattens the Cloudflare namespace augmentation back into a normal type so
// the rest of the codebase doesn't need to know about the SDK's typing
// gymnastics.
export type AgentEnv = Cloudflare.Env;

// ─── Agent kinds ────────────────────────────────────────────────────────────

export type AgentKind =
	| "household"
	| "plan"
	| "meal"
	| "shop"
	| "cook"
	| "member"
	| "cooking_lead";

export const AGENT_BINDING_FOR_KIND: Record<AgentKind, keyof AgentEnv> = {
	household: "HOUSEHOLD_AGENT",
	plan: "PLAN_AGENT",
	meal: "MEAL_AGENT",
	shop: "SHOP_AGENT",
	cook: "COOK_AGENT",
	member: "MEMBER_AGENT",
	cooking_lead: "COOKING_LEAD_AGENT",
};

// ─── DO id helpers ──────────────────────────────────────────────────────────
//
// Every DO is named via `idFromName`. The naming convention is documented in
// the README; these helpers are the single source of truth.

export const householdAgentName = (household_id: string): string =>
	`household:${household_id}`;

export const planAgentName = (plan_id: string): string => `plan:${plan_id}`;

/**
 * Meal agent name matches the existing meal_id format used by plan-world
 * (date+slot scoped to a plan). The DO name is intentionally identical to
 * the meal_id so the existing tracing/replay layer can address them by id.
 */
export const mealAgentName = (
	plan_id: string,
	date: string,
	slot: string,
): string => `meal:${plan_id}:${date}:${slot}`;

export const shopAgentName = (
	plan_id: string,
	shop_run_id: string,
): string => `shop:${plan_id}:${shop_run_id}`;

export const cookAgentName = (
	meal_id: string,
	session_id: string,
): string => `cook:${meal_id}:${session_id}`;

export const memberAgentName = (
	household_id: string,
	member_id: string,
): string => `member:${household_id}:${member_id}`;

/**
 * CookingLeadAgent name. The cook_session_id is the ulid generated at
 * MealAgent.active_cook entry, so the DO id is identical to the row in
 * D1.mise_cook_sessions for the running session.
 */
export const cookingLeadAgentName = (cook_session_id: string): string =>
	`cooking_lead:${cook_session_id}`;

// ─── MealAgent state machine ────────────────────────────────────────────────

/**
 * Canonical phase set for the MealAgent state machine. The order here is
 * forward-only along the happy path. `archived` is terminal. Wave 7B fills
 * in the per-phase alarm + transition logic; this enum just locks the names.
 */
export const MEAL_PHASES = [
	"planned",
	"pre_eve",
	"day_of",
	"cook_window",
	"active_cook",
	"eaten",
	"archived",
] as const;
export type MealPhase = typeof MEAL_PHASES[number];

/**
 * Legal next phases from each current phase. Backwards moves are allowed only
 * where Wave 7B will need them (e.g. cancellation rolling a meal back to
 * `planned`). Wave 7B can extend this map; the foundation just guarantees
 * the keys exist and the forward path is correct.
 */
export const MEAL_TRANSITIONS: Record<MealPhase, ReadonlyArray<MealPhase>> = {
	planned: ["pre_eve", "archived"],
	pre_eve: ["day_of", "planned", "archived"],
	day_of: ["cook_window", "pre_eve", "archived"],
	cook_window: ["active_cook", "day_of", "archived"],
	active_cook: ["eaten", "cook_window", "archived"],
	eaten: ["archived"],
	archived: [],
};

export const SHOP_PHASES = ["planned", "active_today", "completed"] as const;
export type ShopPhase = typeof SHOP_PHASES[number];

export const SHOP_TRANSITIONS: Record<ShopPhase, ReadonlyArray<ShopPhase>> = {
	planned: ["active_today", "completed"],
	active_today: ["completed", "planned"],
	completed: [],
};

export const COOK_PHASES = [
	"planned",
	"pre_session",
	"active_session",
	"completed",
] as const;
export type CookPhase = typeof COOK_PHASES[number];

export const COOK_TRANSITIONS: Record<CookPhase, ReadonlyArray<CookPhase>> = {
	planned: ["pre_session", "completed"],
	pre_session: ["active_session", "planned", "completed"],
	active_session: ["completed", "pre_session"],
	completed: [],
};

/**
 * Generic guard helper. Returns true when `next` is a legal transition from
 * `current`, given the supplied transition map. Used by every entity DO's
 * `transitionTo` method.
 */
export function isLegalTransition<P extends string>(
	transitions: Record<P, ReadonlyArray<P>>,
	current: P,
	next: P,
): boolean {
	const allowed = transitions[current];
	if (!allowed) return false;
	return allowed.includes(next);
}

// ─── Phase-transition audit row ─────────────────────────────────────────────
//
// Every transitionTo() call writes one row into the agent's embedded
// `phase_transitions` table. Shape is identical across MealAgent, ShopAgent,
// CookAgent so the schema migrations and read paths stay uniform.

export interface PhaseTransitionRow {
	id: string;             // ulid-like; agent generates it
	from_phase: string;     // null on first row → represented as "" so column stays NOT NULL
	to_phase: string;
	at_ms: number;          // Date.now()
	reason: string | null;  // free-text, e.g. "alarm:pre_eve" / "manual:cancel"
}

// ─── Alarm scheduling ───────────────────────────────────────────────────────
//
// Each phase will eventually have a `nextAlarmFn(state) → Date | null`. Wave
// 7B wires real rules (e.g. pre_eve fires 24h before meal time). For Wave 7
// foundation every rule returns `null` and `scheduleNextAlarm` is a no-op
// when called with a null target — this guarantees the DO compiles and the
// runtime won't get woken for stub agents that haven't shipped behaviour yet.

export type NextAlarmFn<S> = (state: S) => Date | null;

export interface AlarmScheduleResult {
	scheduled: boolean;
	at?: string;
}

/**
 * Schedule an alarm callback on an Agent SDK instance. Returns scheduled=false
 * if the rule produced null (no alarm needed). Pass a callback name that
 * exists on the agent; the SDK validates `keyof this`.
 */
export async function scheduleNextAlarm<A extends { schedule: Function }, S>(
	agent: A,
	state: S,
	rule: NextAlarmFn<S>,
	callbackName: string,
	payload?: unknown,
): Promise<AlarmScheduleResult> {
	const at = rule(state);
	if (!at) return { scheduled: false };
	await agent.schedule(at, callbackName, payload);
	return { scheduled: true, at: at.toISOString() };
}

// ─── ID generation ──────────────────────────────────────────────────────────

/**
 * Generate a sortable id with the given prefix. We don't depend on `ulid`
 * to avoid a new top-level dep — Date.now() + random suffix is enough for
 * append-only audit rows. Wave 7B can swap to a real ulid if needed.
 */
export function generateAgentId(prefix: string): string {
	const t = Date.now().toString(36);
	const r = Math.random().toString(36).slice(2, 10);
	return `${prefix}_${t}_${r}`;
}

// ─── Phase-transition log SQL helper ────────────────────────────────────────
//
// Each entity DO calls `ensurePhaseTransitionsTable(agent)` from `onStart` to
// guarantee the embedded SQLite has the audit table. The table is identical
// across all phase-bearing DOs so the schema lives here.
//
// Wave 7B: if you need extra columns (e.g. trace_id linkage), add them here
// and bump the schema migration with an `ALTER TABLE` that targets older
// rows. Don't fork per-agent.

export interface AgentSqlSink {
	sql: <T = Record<string, unknown>>(
		strings: TemplateStringsArray,
		...values: (string | number | boolean | null)[]
	) => T[];
}

export function ensurePhaseTransitionsTable(agent: AgentSqlSink): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS phase_transitions (
			id TEXT PRIMARY KEY,
			from_phase TEXT NOT NULL,
			to_phase TEXT NOT NULL,
			at_ms INTEGER NOT NULL,
			reason TEXT
		)
	`;
}

export function recordPhaseTransition(
	agent: AgentSqlSink,
	row: PhaseTransitionRow,
): void {
	agent.sql`
		INSERT INTO phase_transitions (id, from_phase, to_phase, at_ms, reason)
		VALUES (${row.id}, ${row.from_phase}, ${row.to_phase}, ${row.at_ms}, ${row.reason})
	`;
}

export function listPhaseTransitions(
	agent: AgentSqlSink,
): PhaseTransitionRow[] {
	return agent.sql<PhaseTransitionRow>`
		SELECT id, from_phase, to_phase, at_ms, reason
		FROM phase_transitions
		ORDER BY at_ms ASC
	`;
}
