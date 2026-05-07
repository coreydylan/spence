// Wave 7B Phase 2 — DO routing helper.
//
// Bridges the legacy D1-direct MCP handlers to the entity Durable Objects.
// The pattern is "sidecar": the existing handler keeps writing to D1 (so
// callers see the same return shape), and `routeToDO` fires-and-pings the
// matching DO so the lifecycle state machine wakes up. DO failures are
// swallowed (logged) — the MCP call is still authoritative on D1, and a
// later DO probe can re-init from D1.
//
// Used by:
//   * plan_create  → pings HouseholdAgent then PlanAgent (init).
//   * plan_finalize → calls PlanAgent.finalize (spawns child meals + shops).
//   * plan_archive  → calls PlanAgent.archive (signals children).
//   * plan_compose_meal → MealAgent.init for the new meal.
//   * plan_cancel_meal  → MealAgent.cancel for the removed meal.
//   * member_*  → MemberAgent.{init,ping-presence,skill-outcome}.
//
// The helper is intentionally untyped on env beyond the Cloudflare DO
// namespaces — the same shape works for the worker's MiseGraphEnv-extended
// Env interface. If you add a new DO kind, extend AgentKind in base.ts and
// add a binding lookup here.

import type { MiseGraphEnv } from "../types";
import {
	cookAgentName,
	cookingLeadAgentName,
	householdAgentName,
	mealAgentName,
	memberAgentName,
	planAgentName,
	shopAgentName,
} from "./base";

// ─── Env shim ───────────────────────────────────────────────────────────────
// The MCP handlers thread through a MiseGraphEnv-typed env, but the agent
// bindings live on the Worker Env (defined in mise-graph-worker.ts). We treat
// the bindings as optional — when a test runs the MCP path against a mock
// env without DO namespaces, all routeTo* calls are no-ops.

interface AgentEnvShim {
	HOUSEHOLD_AGENT?: DurableObjectNamespace;
	PLAN_AGENT?: DurableObjectNamespace;
	MEAL_AGENT?: DurableObjectNamespace;
	SHOP_AGENT?: DurableObjectNamespace;
	COOK_AGENT?: DurableObjectNamespace;
	MEMBER_AGENT?: DurableObjectNamespace;
	// Wave 8B Track C — brigade lead routing.
	COOKING_LEAD_AGENT?: DurableObjectNamespace;
}

type MaybeAgentEnv = MiseGraphEnv & AgentEnvShim;

// ─── Generic DO call helper ─────────────────────────────────────────────────

/**
 * Call an internal route on a DO by namespace + name, posting JSON. Returns
 * the parsed JSON response or null on failure. NEVER throws — the goal is
 * "best-effort sidecar"; production handlers shouldn't fail because a DO is
 * temporarily unreachable.
 */
async function callDO(
	ns: DurableObjectNamespace | undefined,
	name: string,
	action: string,
	body: unknown,
	method: "GET" | "POST" = "POST",
): Promise<Record<string, unknown> | null> {
	if (!ns) return null;
	try {
		const stub = ns.get(ns.idFromName(name));
		const init: RequestInit = {
			method,
			headers: { "content-type": "application/json" },
		};
		if (method === "POST") init.body = JSON.stringify(body ?? {});
		const resp = await stub.fetch(new Request(`https://agent/internal/${action}`, init));
		const text = await resp.text();
		try {
			return JSON.parse(text) as Record<string, unknown>;
		} catch {
			return { ok: resp.ok, raw: text };
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`[router] DO call failed (${name}/${action}): ${message}`);
		return null;
	}
}

// ─── Household + plan lifecycle ─────────────────────────────────────────────

/**
 * After plan_create: ensure the HouseholdAgent (if household_id) and the
 * PlanAgent are initialized. Called by the trace-wrapped MCP handler.
 */
export async function routePlanCreated(
	env: MaybeAgentEnv,
	args: { plan_id: string; household_id: string | null },
): Promise<void> {
	const e = env as MaybeAgentEnv;
	if (args.household_id) {
		await callDO(
			e.HOUSEHOLD_AGENT,
			householdAgentName(args.household_id),
			"init",
			{ household_id: args.household_id },
		);
	}
	await callDO(
		e.PLAN_AGENT,
		planAgentName(args.plan_id),
		"init",
		{
			plan_id: args.plan_id,
			household_id: args.household_id ?? undefined,
		},
	);
}

/**
 * Drive PlanAgent.finalize — spawns child MealAgents + ShopAgents inside the
 * DO. Called after the MCP handler has flipped D1 markActivePlanFinal.
 */
export async function routePlanFinalized(
	env: MaybeAgentEnv,
	args: { plan_id: string; household_id?: string | null },
): Promise<Record<string, unknown> | null> {
	const e = env as MaybeAgentEnv;
	// Init is idempotent and ensures the DO has plan_id/household_id even
	// when finalize was the first call after a worker restart.
	await callDO(
		e.PLAN_AGENT,
		planAgentName(args.plan_id),
		"init",
		{ plan_id: args.plan_id, household_id: args.household_id ?? undefined },
	);
	return await callDO(
		e.PLAN_AGENT,
		planAgentName(args.plan_id),
		"finalize",
		{},
	);
}

/** Drive PlanAgent.archive after the MCP handler removes the plan from D1. */
export async function routePlanArchived(
	env: MaybeAgentEnv,
	args: { plan_id: string },
): Promise<Record<string, unknown> | null> {
	const e = env as MaybeAgentEnv;
	return await callDO(
		e.PLAN_AGENT,
		planAgentName(args.plan_id),
		"archive",
		{},
	);
}

// ─── Meal lifecycle ─────────────────────────────────────────────────────────

/**
 * Wake a MealAgent after plan_compose_meal lands a meal in D1. The DO loads
 * its own snapshot from active_plans, so we just need to nudge it.
 */
export async function routeMealComposed(
	env: MaybeAgentEnv,
	args: { plan_id: string; date: string; slot: string; meal_id: string; household_id?: string | null },
): Promise<Record<string, unknown> | null> {
	const e = env as MaybeAgentEnv;
	return await callDO(
		e.MEAL_AGENT,
		mealAgentName(args.plan_id, args.date, args.slot),
		"init",
		{
			meal_id: args.meal_id,
			plan_id: args.plan_id,
			household_id: args.household_id ?? undefined,
		},
	);
}

/**
 * Cancel a MealAgent. The MCP handler has already removed the meal from D1;
 * we tell the DO so it can write a phase_transition row + release equipment
 * claims via its cancelled_entry handler.
 */
export async function routeMealCancelled(
	env: MaybeAgentEnv,
	args: { plan_id: string; date: string; slot: string; reason: string },
): Promise<Record<string, unknown> | null> {
	const e = env as MaybeAgentEnv;
	return await callDO(
		e.MEAL_AGENT,
		mealAgentName(args.plan_id, args.date, args.slot),
		"cancel",
		{ reason: args.reason },
	);
}

// ─── Member lifecycle ───────────────────────────────────────────────────────

export async function routeMemberInit(
	env: MaybeAgentEnv,
	args: { household_id: string; member_id: string },
): Promise<Record<string, unknown> | null> {
	const e = env as MaybeAgentEnv;
	return await callDO(
		e.MEMBER_AGENT,
		memberAgentName(args.household_id, args.member_id),
		"init",
		{ household_id: args.household_id, member_id: args.member_id },
	);
}

export async function routeMemberPingPresence(
	env: MaybeAgentEnv,
	args: {
		household_id: string;
		member_id: string;
		state: string;
		current_task_id?: string;
		current_session_id?: string;
	},
): Promise<Record<string, unknown> | null> {
	const e = env as MaybeAgentEnv;
	// Ensure DO knows its member_id/household_id (idempotent).
	await callDO(
		e.MEMBER_AGENT,
		memberAgentName(args.household_id, args.member_id),
		"init",
		{ household_id: args.household_id, member_id: args.member_id },
	);
	return await callDO(
		e.MEMBER_AGENT,
		memberAgentName(args.household_id, args.member_id),
		"ping-presence",
		{
			state: args.state,
			current_task_id: args.current_task_id,
			current_session_id: args.current_session_id,
		},
	);
}

export async function routeMemberSkillOutcome(
	env: MaybeAgentEnv,
	args: {
		household_id: string;
		member_id: string;
		skill_name: string;
		outcome: string;
		duration_actual_min?: number;
		duration_expected_min?: number;
		user_rating?: number;
		task_id?: string;
		meal_id?: string;
		notes?: string;
	},
): Promise<Record<string, unknown> | null> {
	const e = env as MaybeAgentEnv;
	await callDO(
		e.MEMBER_AGENT,
		memberAgentName(args.household_id, args.member_id),
		"init",
		{ household_id: args.household_id, member_id: args.member_id },
	);
	return await callDO(
		e.MEMBER_AGENT,
		memberAgentName(args.household_id, args.member_id),
		"skill-outcome",
		{
			skill_name: args.skill_name,
			outcome: args.outcome,
			duration_actual_min: args.duration_actual_min,
			duration_expected_min: args.duration_expected_min,
			user_rating: args.user_rating,
			task_id: args.task_id,
			meal_id: args.meal_id,
			notes: args.notes,
		},
	);
}

// ─── Direct DO probes (used by the bridge routes in mise-graph-worker.ts) ──

export interface DOProbeArgs {
	kind: "household" | "plan" | "meal" | "shop" | "cook" | "member";
	id: string;
	action: string;
	method: "GET" | "POST";
	body?: unknown;
}

export async function probeDO(
	env: MaybeAgentEnv,
	args: DOProbeArgs,
): Promise<Response> {
	const e = env as MaybeAgentEnv;
	const ns = (() => {
		switch (args.kind) {
			case "household": return e.HOUSEHOLD_AGENT;
			case "plan": return e.PLAN_AGENT;
			case "meal": return e.MEAL_AGENT;
			case "shop": return e.SHOP_AGENT;
			case "cook": return e.COOK_AGENT;
			case "member": return e.MEMBER_AGENT;
		}
	})();
	if (!ns) {
		return new Response(JSON.stringify({ error: `binding for ${args.kind} not configured` }), {
			status: 503,
			headers: { "content-type": "application/json" },
		});
	}
	const stub = ns.get(ns.idFromName(args.id));
	const init: RequestInit = {
		method: args.method,
		headers: { "content-type": "application/json" },
	};
	if (args.method === "POST") init.body = JSON.stringify(args.body ?? {});
	return stub.fetch(new Request(`https://agent/internal/${args.action}`, init));
}

// ─── CookingLeadAgent routing (Wave 8B Track C) ────────────────────────────
//
// Generic routing helper for the brigade DO. Used by the brigade_* MCP tools
// in plan-world-mcp.ts so each tool stays a thin wrapper over a single DO
// route. Returns the parsed JSON response (or null on failure / missing
// binding). NEVER throws — best-effort sidecar pattern.

export async function routeCookingLead(
	env: MaybeAgentEnv,
	cook_session_id: string,
	action: string,
	payload?: unknown,
	method: "GET" | "POST" = "POST",
): Promise<Record<string, unknown> | null> {
	const e = env as MaybeAgentEnv;
	if (!cook_session_id) return null;
	return await callDO(
		e.COOKING_LEAD_AGENT,
		cookingLeadAgentName(cook_session_id),
		action,
		payload,
		method,
	);
}

// Re-export name helpers so the worker bridge can use them without re-importing
// from base.ts (kept here so router.ts is the only place that "knows" how to
// address the DOs).
export {
	cookAgentName,
	cookingLeadAgentName,
	householdAgentName,
	mealAgentName,
	memberAgentName,
	planAgentName,
	shopAgentName,
};
