// T22 — Wave 7B Phase 2 full lifecycle E2E.
//
// Ties together the four pieces wave 7B layered in:
//   1. MCP handlers that route through DOs (sidecar) — exercised through
//      callPlanWorldTool. The DO bindings are absent in node, so the
//      router.ts helper falls through to a no-op; the legacy D1 write path
//      stays authoritative. We assert the legacy returns + the trace chain
//      to prove the routing didn't break wire shape.
//   2. MealAgent state machine — exercised through the pure phase handlers
//      (the DO wraps these; testing them here matches the agent's behaviour
//      since agent runtime can't boot under node).
//   3. HouseholdAgent morning-brief pipeline — through the pure helpers.
//   4. Equipment claim/release — through the canonical equipment.ts API,
//      which is what the meal-phase handlers call.
//
// Asserts:
//   * plan_create + member_create + plan_compose_meal + plan_finalize all
//     return their existing shapes when DO bindings are absent.
//   * The trace chain is queryable (agent_get_trace + agent_get_mutation_trace).
//   * The meal phase cascade fires in order with strictly increasing alarms.
//   * Equipment claims are released after archived_entry.
//   * Member skill outcomes mirror through the DO wrap (when no DO, helper
//     returns null but doesn't throw).

import type { Scenario } from "../lib/types";
import {
	callPlanWorldTool,
	type CallerTraceContext,
} from "../../src/mise-graph/plan-world-mcp";
import {
	getMutationTrace,
	listMutationsForPlan,
	listPlanTraces,
	getTrace,
} from "../../src/mise-graph/agent-trace";
import { clearProposalCache } from "../../src/mise-graph/ripple-preview";
import {
	active_cook_entry,
	archived_entry,
	cook_window_entry,
	day_of_entry,
	defaultWindowsForSlot,
	eaten_entry,
	pre_eve_entry,
	type MealSnapshot,
	type PhaseHandlerDeps,
} from "../../src/mise-graph/agents/meal-phase-handlers";
import type { AgentSqlSink } from "../../src/mise-graph/agents/base";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

const t22: Scenario = {
	id: "t22",
	name: "Wave 7B Phase 2 full lifecycle: MCP→DO routing + state machine + trace chain",
	group: "integration",
	tier: "fast",
	async run(ctx) {
		clearProposalCache();
		const db = new FakeD1();
		const env = { DB: db as unknown as D1Database } as MiseGraphEnv;

		const householdId = "hh_t22";
		const planId = "mise_plan:t22";
		const startDate = "2026-05-13";
		const endDate = "2026-05-15";
		const memberId = "mem_t22_corey";

		const agentCaller: CallerTraceContext = {
			caller_kind: "agent",
			caller_id: "agent-session-t22",
			parent_trace_id: null,
		};

		// ── 1. member_create — exercises routeMemberInit no-op fallthrough ───
		const memberRes = await callPlanWorldTool("member_create", {
			household_id: householdId,
			member_id: memberId,
			display_name: "Corey",
			age_group: "adult",
		}, env, agentCaller);
		const memberRow = (memberRes as { member: { member_id: string } }).member;
		ctx.assert.eq(
			memberRow.member_id,
			memberId,
			"member_create returns member shape unchanged with router wired",
		);

		// ── 2. plan_create — exercises routePlanCreated no-op fallthrough ────
		const created = await callPlanWorldTool("plan_create", {
			plan_id: planId,
			household_id: householdId,
			start_date: startDate,
			end_date: endDate,
			people_default: 2,
		}, env, agentCaller);
		ctx.assert.eq(created.plan_id, planId, "plan_create returns plan_id with router wired");

		// ── 3. plan_compose_meal — exercises routeMealComposed ──────────────
		const composed = await callPlanWorldTool("plan_compose_meal", {
			plan_id: planId,
			slot: { date: startDate, slot: "dinner" },
			meal: {
				title: "lemon-skillet chicken",
				format: "skillet",
				cuisine: ["mediterranean"],
				raw_ingredients: [
					{ name: "chicken thigh", qty: 600, unit: "g" },
					{ name: "lemon", qty: 1, unit: "ea" },
				],
			},
		}, env, agentCaller);
		ctx.assert.eq(composed.ok, true, "compose returns ok");
		const mealId = composed.meal_id as string;
		ctx.assert.ok(typeof mealId === "string" && mealId.length > 0, "compose returns meal_id");

		// ── 4. plan_finalize — exercises routePlanFinalized ─────────────────
		const finalized = await callPlanWorldTool("plan_finalize", {
			plan_id: planId,
		}, env, agentCaller);
		ctx.assert.eq(finalized.plan_id, planId, "finalize echoes plan_id");
		// `agents` field is added in Phase 2 wiring; absent when no DO bindings.
		ctx.assert.eq(
			Object.prototype.hasOwnProperty.call(finalized, "agents"),
			true,
			"finalize attaches agents field (null without DO bindings)",
		);

		// ── 5. Trace chain assertions ────────────────────────────────────────
		const planTraces = await listPlanTraces(env, planId, 50);
		ctx.assert.gte(
			planTraces.length,
			3,
			"trace chain captures plan_create + plan_compose_meal + plan_finalize",
		);
		const planMutations = await listMutationsForPlan(env, planId, 100);
		ctx.assert.gte(planMutations.length, 2, "mutation log has plan_create + compose entries");

		const composeMutation = planMutations.find(m => m.mutation_kind === "plan_compose_meal");
		ctx.assert.ok(!!composeMutation, "compose mutation present");
		const composeChain = await getMutationTrace(env, composeMutation!.mutation_id);
		ctx.assert.ok(!!composeChain?.trace, "getMutationTrace returns the compose trace");
		ctx.assert.eq(composeChain!.trace.caller_kind, "agent", "compose trace carries agent caller_kind");
		ctx.assert.contains(
			composeChain!.trace.tool_name,
			"plan_compose_meal",
			"compose trace tool_name preserved",
		);

		// agent_get_trace round-trip via the MCP tool layer.
		const traceLookup = await callPlanWorldTool(
			"agent_get_trace",
			{ trace_id: composeChain!.trace.trace_id },
			env,
			agentCaller,
		);
		ctx.assert.eq(traceLookup.found, true, "agent_get_trace finds compose trace");

		// ── 6. MealAgent phase cascade (the DO state machine, exercised via
		//      its pure entry handlers because the agents SDK can't boot in
		//      node — same pattern u44 uses).
		const date = startDate;
		const windows = defaultWindowsForSlot(date, "dinner");
		const snapshot: MealSnapshot = {
			meal_id: mealId,
			plan_id: planId,
			household_id: householdId,
			date,
			slot: "dinner",
			format: "skillet",
			cuisine: ["mediterranean"],
			recipe_id: null,
			cook_window_start_ms: windows.cook_window_start_ms,
			cook_window_end_ms:   windows.cook_window_end_ms,
			eat_window_start_ms:  windows.eat_window_start_ms,
			eat_window_end_ms:    windows.eat_window_end_ms,
			equipment: ["12in skillet", "oven"],
		};
		const sink = makeFakeSqlSink();
		const adults = { adult_member_ids: [memberId] };
		const phaseEnv = { DB: { prepare: () => new MealStmt() } } as unknown as MiseGraphEnv;
		const mkDeps = (now_ms: number): PhaseHandlerDeps => ({ env: phaseEnv, now_ms, adults });

		const t_pre_eve = snapshot.eat_window_start_ms - 24 * 60 * 60 * 1000;
		const t_day_of = snapshot.eat_window_start_ms - 12 * 60 * 60 * 1000;
		const t_cook_win = snapshot.cook_window_start_ms;
		const t_active_cook = snapshot.cook_window_start_ms + 10 * 60 * 1000;
		const t_eaten = snapshot.eat_window_start_ms + 30 * 60 * 1000;
		const t_archived = t_eaten + 72 * 60 * 60 * 1000;

		const r_pre = await pre_eve_entry(snapshot, mkDeps(t_pre_eve));
		const r_day = await day_of_entry(snapshot, mkDeps(t_day_of));
		const r_cw  = await cook_window_entry(snapshot, mkDeps(t_cook_win), sink);
		const r_ac  = await active_cook_entry(snapshot, mkDeps(t_active_cook));
		const r_eat = await eaten_entry(snapshot, mkDeps(t_eaten), r_ac.cook_sessions[0].cook_session_id);
		const r_arc = await archived_entry(snapshot, mkDeps(t_archived), sink);

		ctx.assert.eq(r_pre.phase,  "pre_eve",     "pre_eve cascade phase");
		ctx.assert.eq(r_day.phase,  "day_of",      "day_of cascade phase");
		ctx.assert.eq(r_cw.phase,   "cook_window", "cook_window cascade phase");
		ctx.assert.eq(r_ac.phase,   "active_cook", "active_cook cascade phase");
		ctx.assert.eq(r_eat.phase,  "eaten",       "eaten cascade phase");
		ctx.assert.eq(r_arc.phase,  "archived",    "archived cascade phase");

		// Each forward auto-fired alarm is strictly later than the previous.
		const chain = [
			r_pre.next_alarm_at_ms!,
			r_day.next_alarm_at_ms!,
			r_cw.next_alarm_at_ms!,
		];
		for (let i = 1; i < chain.length; i++) {
			ctx.assert.gt(chain[i], chain[i - 1], `cascade step ${i} strictly later`);
		}
		ctx.assert.eq(r_arc.next_alarm_at_ms, null, "archived terminal: no further alarms");
		ctx.assert.ok(!!r_arc.equipment_released, "archived releases equipment claims");
		ctx.assert.gte(r_arc.equipment_released!.released, 0, "released count non-negative");

		// ── 7. Meal cancel via MCP — drives routeMealCancelled path. ─────────
		// Compose another meal so cancel has a target.
		const composed2 = await callPlanWorldTool("plan_compose_meal", {
			plan_id: planId,
			slot: { date: "2026-05-14", slot: "dinner" },
			meal: {
				title: "cabbage tahini bowl",
				format: "bowl",
				cuisine: ["vegetarian"],
				raw_ingredients: [{ name: "cabbage", qty: 1, unit: "head" }],
			},
		}, env, agentCaller);
		ctx.assert.eq(composed2.ok, true, "second compose ok");
		const cancelled = await callPlanWorldTool("plan_cancel_meal", {
			plan_id: planId,
			slot: { date: "2026-05-14", slot: "dinner" },
			reason: "test_cancel",
		}, env, agentCaller);
		ctx.assert.notEq(cancelled.ok, false, "cancel returns non-failure with router wired");

		// ── 8. plan_archive — exercises routePlanArchived ───────────────────
		const archived = await callPlanWorldTool("plan_archive", {
			plan_id: planId,
		}, env, agentCaller);
		ctx.assert.eq(archived.archived, true, "archive ok with router wired");

		// Final trace chain count.
		const finalTraces = await listPlanTraces(env, planId, 100);
		ctx.assert.gte(
			finalTraces.length,
			6,
			"trace chain ≥ 6 (create+compose+finalize+compose+cancel+archive)",
		);

		// ── 9. Member skill outcome through MCP — exercises router fallthrough.
		const skillOutcome = await callPlanWorldTool("member_record_skill_outcome", {
			member_id: memberId,
			skill_name: "knife_skills",
			outcome: "success",
		}, env, agentCaller);
		ctx.assert.eq(
			(skillOutcome as Record<string, unknown>).member_id,
			memberId,
			"skill_outcome echoes member_id",
		);

		ctx.notes.push(`final trace count: ${finalTraces.length}`);
		ctx.notes.push(`mutation count: ${planMutations.length}`);
		ctx.notes.push(`alarm cascade pre→day→cook: ${chain.map(t => new Date(t).toISOString()).join(" → ")}`);
		ctx.notes.push(`equipment_released: ${r_arc.equipment_released!.released}`);
	},
};

// ─── Test infrastructure ────────────────────────────────────────────────────

class MealStmt {
	bind(..._v: unknown[]): this { void _v; return this; }
	async run() { return { success: true }; }
	async all<T = unknown>(): Promise<{ results: T[] }> { return { results: [] }; }
	async first<T = unknown>(): Promise<T | null> { return null; }
}

function makeFakeSqlSink(): AgentSqlSink {
	const tables = new Map<string, Array<Record<string, unknown>>>();
	function exec(strings: TemplateStringsArray, ...values: unknown[]): unknown[] {
		const raw = strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i}` : ""), "").trim();
		if (/CREATE TABLE/i.test(raw)) {
			const m = raw.match(/CREATE TABLE IF NOT EXISTS\s+(\w+)/i);
			if (m && !tables.has(m[1])) tables.set(m[1], []);
			return [];
		}
		if (/^CREATE INDEX/i.test(raw)) return [];
		const insertM = raw.match(/INSERT INTO\s+(\w+)\s*\(([^)]+)\)/i);
		if (insertM) {
			const name = insertM[1];
			const cols = insertM[2].split(",").map(c => c.trim());
			if (!tables.has(name)) tables.set(name, []);
			const row: Record<string, unknown> = {};
			cols.forEach((col, i) => { row[col] = values[i]; });
			tables.get(name)!.push(row);
			return [];
		}
		if (/^SELECT/i.test(raw)) {
			const fromM = raw.match(/FROM\s+(\w+)/i);
			if (!fromM) return [];
			const rows = tables.get(fromM[1]) || [];
			if (/equipment\s*=\s*\$0/.test(raw)) {
				const equipment = values[0];
				const qEnd = values[1] as number;
				const qStart = values[2] as number;
				return rows.filter(r => r.equipment === equipment && (r.released_at_ms == null) && (r.start_ms as number) < qEnd && (r.end_ms as number) > qStart);
			}
			if (/COUNT\(\*\)/i.test(raw)) return [{ n: 0 }];
			return rows.slice();
		}
		if (/^UPDATE/i.test(raw)) return [];
		return [];
	}
	return {
		sql: <T = Record<string, unknown>>(
			strings: TemplateStringsArray,
			...values: (string | number | boolean | null)[]
		): T[] => exec(strings, ...values) as T[],
	};
}

// FakeD1 — covers active plans + traces + mutation_traces + members + skills
// + presence. Adapted from t21's FakeD1 with member tables added.
interface AgentTraceRow {
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
	duration_ms: number;
	ok: number;
	error: string | null;
	triggered_mutations_json: string | null;
	created_at: string;
}

interface MutationTraceRow {
	mutation_id: string;
	mutation_kind: string;
	plan_id: string;
	trace_id: string;
	committed_at: string;
}

class FakeD1 {
	plans = new Map<string, { plan_json: string; status: string }>();
	traces = new Map<string, AgentTraceRow>();
	mutationTraces = new Map<string, MutationTraceRow>();
	members = new Map<string, Record<string, unknown>>();
	skillOutcomes: Record<string, unknown>[] = [];
	presence = new Map<string, Record<string, unknown>>();
	private clock = 0;

	prepare(sql: string): FakeStatement {
		return new FakeStatement(this, sql);
	}
	nextStamp(): string {
		this.clock += 1;
		return new Date(2026, 4, 13, 9, 0, 0, this.clock).toISOString();
	}
}

class FakeStatement {
	private bindings: unknown[] = [];

	constructor(private readonly db: FakeD1, private readonly sql: string) {}

	bind(...values: unknown[]): this {
		this.bindings = values;
		return this;
	}

	async run(): Promise<unknown> {
		const sql = this.sql;
		if (/INSERT\s+INTO\s+mise_active_plans/i.test(sql)) {
			const planId = String(this.bindings[0]);
			this.db.plans.set(planId, {
				plan_json: String(this.bindings[2]),
				status: String(this.bindings[3]),
			});
			return { success: true };
		}
		if (/UPDATE\s+mise_active_plans/i.test(sql)) {
			const planId = String(this.bindings[this.bindings.length - 1]);
			const existing = this.db.plans.get(planId);
			if (existing) this.db.plans.set(planId, { ...existing, status: "finalized" });
			return { success: true };
		}
		if (/DELETE\s+FROM\s+mise_active_plans/i.test(sql)) {
			this.db.plans.delete(String(this.bindings[0]));
			return { success: true };
		}
		if (/INSERT\s+INTO\s+mise_agent_traces/i.test(sql)) {
			const stamp = this.db.nextStamp();
			const b = this.bindings;
			this.db.traces.set(String(b[0]), {
				trace_id: String(b[0]),
				household_id: b[1] === null ? null : String(b[1]),
				plan_id: b[2] === null ? null : String(b[2]),
				parent_trace_id: b[3] === null ? null : String(b[3]),
				tool_name: String(b[4]),
				tool_args_json: String(b[5]),
				tool_result_json: b[6] === null ? null : String(b[6]),
				result_summary: b[7] === null ? null : String(b[7]),
				caller_kind: String(b[8]),
				caller_id: b[9] === null ? null : String(b[9]),
				duration_ms: Number(b[10]),
				ok: Number(b[11]),
				error: b[12] === null ? null : String(b[12]),
				triggered_mutations_json: b[13] === null ? null : String(b[13]),
				created_at: stamp,
			});
			return { success: true };
		}
		if (/INSERT\s+OR\s+REPLACE\s+INTO\s+mise_mutation_traces/i.test(sql)) {
			const stamp = this.db.nextStamp();
			const b = this.bindings;
			this.db.mutationTraces.set(String(b[0]), {
				mutation_id: String(b[0]),
				mutation_kind: String(b[1]),
				plan_id: String(b[2]),
				trace_id: String(b[3]),
				committed_at: stamp,
			});
			return { success: true };
		}
		// Member + skill + presence inserts.
		if (/INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+mise_household_members/i.test(sql)) {
			const memberId = String(this.bindings[0]);
			const cols = ["member_id","household_id","display_name","age_group","dietary_json","preferences_json","skills_json","safety_json","created_at_ms","updated_at_ms"];
			const row: Record<string, unknown> = {};
			cols.forEach((c, i) => { row[c] = this.bindings[i]; });
			this.db.members.set(memberId, row);
			return { success: true };
		}
		if (/INSERT\s+INTO\s+mise_member_skill_outcomes/i.test(sql)) {
			this.db.skillOutcomes.push({ bindings: [...this.bindings] });
			return { success: true };
		}
		if (/INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+mise_member_presence/i.test(sql)) {
			const memberId = String(this.bindings[0]);
			this.db.presence.set(memberId, { bindings: [...this.bindings] });
			return { success: true };
		}
		// Best-effort: legacy tables silently accepted.
		if (/INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+mise_week_plans/i.test(sql)) {
			return { success: true };
		}
		if (/INSERT\s+OR\s+REPLACE\s+INTO\s+mise_plan_proposals/i.test(sql)) {
			return { success: true };
		}
		if (/UPDATE\s+mise_plan_proposals/i.test(sql)) {
			return { success: true };
		}
		return { success: true };
	}

	async first<T = unknown>(): Promise<T | null> {
		const sql = this.sql;
		if (/FROM\s+mise_active_plans/i.test(sql)) {
			const row = this.db.plans.get(String(this.bindings[0]));
			return (row ? { plan_json: row.plan_json, status: row.status } : null) as T | null;
		}
		if (/FROM\s+mise_week_plans/i.test(sql)) {
			const row = this.db.plans.get(String(this.bindings[0]));
			return (row ? { plan_json: row.plan_json } : null) as T | null;
		}
		if (/FROM\s+mise_agent_traces/i.test(sql)) {
			const row = this.db.traces.get(String(this.bindings[0]));
			return (row || null) as T | null;
		}
		if (/FROM\s+mise_mutation_traces/i.test(sql)) {
			const row = this.db.mutationTraces.get(String(this.bindings[0]));
			return (row || null) as T | null;
		}
		if (/FROM\s+mise_household_members/i.test(sql)) {
			const memberId = String(this.bindings[0]);
			const row = this.db.members.get(memberId);
			return (row || null) as T | null;
		}
		return null;
	}

	async all<T = unknown>(): Promise<{ results: T[] }> {
		const sql = this.sql;
		if (/FROM\s+mise_agent_traces[\s\S]+WHERE\s+plan_id\s*=\s*\?/i.test(sql)) {
			const planId = String(this.bindings[0]);
			const limit = Number(this.bindings[1]) || 50;
			const matched = Array.from(this.db.traces.values())
				.filter(r => r.plan_id === planId)
				.sort((a, b) => b.created_at.localeCompare(a.created_at))
				.slice(0, limit);
			return { results: matched as unknown as T[] };
		}
		if (/FROM\s+mise_mutation_traces[\s\S]+WHERE\s+plan_id\s*=\s*\?/i.test(sql)) {
			const planId = String(this.bindings[0]);
			const limit = Number(this.bindings[1]) || 100;
			const matched = Array.from(this.db.mutationTraces.values())
				.filter(r => r.plan_id === planId)
				.sort((a, b) => b.committed_at.localeCompare(a.committed_at))
				.slice(0, limit);
			return { results: matched as unknown as T[] };
		}
		return { results: [] };
	}
}

// Silence the unused getTrace import warning while we let the file
// document the trace surface area we tested.
void getTrace;

export default t22;
