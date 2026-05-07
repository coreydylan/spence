// T21 — Replay debug: real MCP tool calls produce a queryable agent trail.
//
// Drives `callPlanWorldTool` (no mocks above the ledger) through a small
// scripted plan composition: create plan → 3 reads → 2 writes (compose meals).
// Then verifies that:
//   (a) every committed mutation has a row in mise_mutation_traces
//   (b) listMutationsForPlan exposes them
//   (c) getMutationTrace for one of those meals returns its trace + the
//       inner trace shows `caller_kind = "agent"` and a result_summary that
//       names the meal
//   (d) when the second write call's parent_trace_id is set to the first
//       write's trace_id, the ancestor chain walks correctly
// This is the end-to-end "why did Spence pick pizza Saturday?" path.

import type { Scenario } from "../lib/types";
import { callPlanWorldTool, type CallerTraceContext } from "../../src/mise-graph/plan-world-mcp";
import {
	getMutationTrace,
	listMutationsForPlan,
	listPlanTraces,
} from "../../src/mise-graph/agent-trace";
import { clearProposalCache } from "../../src/mise-graph/ripple-preview";

const t21: Scenario = {
	id: "t21",
	name: "Replay debug: agent's MCP calls are persisted with mutation→trace linkage",
	group: "integration",
	tier: "fast",
	async run(ctx) {
		clearProposalCache();
		const db = new FakeD1();
		const env = { DB: db as unknown as D1Database } as { DB: D1Database };

		const planId = "mise_plan:t21";
		const startDate = "2026-05-13";
		const endDate = "2026-05-15";

		// Outer agent context — this is the "human asked the agent to plan
		// the week" call. Subsequent tool calls thread through this.
		const agentCaller: CallerTraceContext = {
			caller_kind: "agent",
			caller_id: "agent-session-t21",
			parent_trace_id: null,
		};

		// 1. Create the plan (write tool — should produce a trace).
		const created = await callPlanWorldTool("plan_create", {
			plan_id: planId,
			household_id: "hh_t21",
			start_date: startDate,
			end_date: endDate,
			people_default: 2,
		}, env, agentCaller);
		ctx.assert.eq(created.plan_id, planId, "plan_create returns plan id");

		// 2. Three reads (not traced — they're high-volume and we skip them
		//    per the wave 6 spec).
		const summary = await callPlanWorldTool("plan_read_summary", { plan_id: planId }, env, agentCaller);
		ctx.assert.ok(!!summary.summary, "plan_read_summary returns summary");

		const empty = await callPlanWorldTool("plan_read_empty_slots", { plan_id: planId }, env, agentCaller);
		ctx.assert.gte(Number((empty as Record<string, unknown>).empty_slots
			? (empty.empty_slots as unknown[]).length
			: 0), 1, "plan_read_empty_slots reports unfilled slots");

		const grievances = await callPlanWorldTool("plan_read_grievances", { plan_id: planId }, env, agentCaller);
		ctx.assert.ok(Array.isArray((grievances as Record<string, unknown>).grievances), "plan_read_grievances returns array");

		// 3. First write: compose Wednesday dinner. This trace is the
		//    parent for the second compose call.
		const wedCompose = await callPlanWorldTool("plan_compose_meal", {
			plan_id: planId,
			slot: { date: "2026-05-13", slot: "dinner" },
			meal: {
				title: "miso-glazed salmon bowl",
				format: "bowl",
				cuisine: ["japanese"],
				raw_ingredients: [
					{ name: "salmon", qty: 200, unit: "g" },
					{ name: "rice", qty: 1, unit: "cup" },
					{ name: "miso", qty: 1, unit: "tbsp" },
				],
			},
		}, env, agentCaller);
		ctx.assert.eq(wedCompose.ok, true, "first compose succeeds");
		const wedMealId = String(wedCompose.meal_id);
		ctx.assert.matches(wedMealId, /^meal:/, "compose returns meal_id");

		// Find the trace that produced the wed meal — we'll thread it as
		// parent_trace_id for the next compose to model an agent that
		// reasoned "I just composed Wed, now compose Thu in light of it".
		const wedReverse = await getMutationTrace(env, wedMealId);
		ctx.assert.ok(!!wedReverse, "wed meal links to a trace");
		const wedTraceId = wedReverse!.trace.trace_id;

		// 4. Second write nested under the first trace.
		const subCaller: CallerTraceContext = {
			caller_kind: "subagent",
			caller_id: "agent-session-t21:thu-step",
			parent_trace_id: wedTraceId,
		};
		const thuCompose = await callPlanWorldTool("plan_compose_meal", {
			plan_id: planId,
			slot: { date: "2026-05-14", slot: "dinner" },
			meal: {
				title: "leftover rice + chickpea bowl",
				format: "bowl",
				cuisine: ["mediterranean"],
				raw_ingredients: [
					{ name: "rice", qty: 1, unit: "cup" },
					{ name: "chickpeas", qty: 1, unit: "can" },
					{ name: "lemon", qty: 1, unit: "" },
				],
			},
		}, env, subCaller);
		ctx.assert.eq(thuCompose.ok, true, "second compose succeeds");
		const thuMealId = String(thuCompose.meal_id);

		// 5. Replay queries — verify everything is persisted.
		const planMutations = await listMutationsForPlan(env, planId);
		ctx.assert.gte(planMutations.length, 2, "at least the two compose mutations are persisted");
		const mutationIds = planMutations.map(m => m.mutation_id);
		ctx.assert.contains(mutationIds, wedMealId, "wed meal id in mutation list");
		ctx.assert.contains(mutationIds, thuMealId, "thu meal id in mutation list");

		// 6. Walk the chain for the Thu meal — should have wed trace as
		//    its single ancestor.
		const thuChain = await getMutationTrace(env, thuMealId);
		ctx.assert.ok(!!thuChain, "thu meal trace lookup succeeds");
		ctx.assert.eq(thuChain!.trace.caller_kind, "subagent", "thu trace was issued by subagent");
		ctx.assert.eq(thuChain!.trace.parent_trace_id, wedTraceId, "thu trace points to wed as parent");
		ctx.assert.eq(thuChain!.ancestors.length, 1, "ancestor chain has length 1");
		ctx.assert.eq(thuChain!.ancestors[0].trace_id, wedTraceId, "first ancestor is wed trace");
		ctx.assert.eq(thuChain!.ancestors[0].caller_kind, "agent", "outermost trace is the agent");
		ctx.assert.eq(thuChain!.ancestors[0].tool_name, "plan_compose_meal", "outermost tool is the wed compose");

		// 7. result_summary should mention something concrete (grievance
		//    counts or meal id) so a debugger can scan the chain quickly.
		ctx.assert.ok(typeof thuChain!.trace.result_summary === "string", "result_summary is set");
		ctx.assert.matches(
			thuChain!.trace.result_summary || "",
			/plan_compose_meal/,
			"result_summary names the tool",
		);

		// 8. listPlanTraces returns a populated history (writes only —
		//    the read tools were skipped).
		const planTraces = await listPlanTraces(env, planId, 100);
		ctx.assert.gte(planTraces.length, 3, "history includes plan_create + two composes");
		const writeToolNames = new Set(planTraces.map(t => t.tool_name));
		ctx.assert.ok(writeToolNames.has("plan_create"), "plan_create is in history");
		ctx.assert.ok(writeToolNames.has("plan_compose_meal"), "plan_compose_meal is in history");

		// 9. The agent-replay MCP tools surface the same data as the
		//    helper functions — they're the production query path.
		const mcpMutations = await callPlanWorldTool("agent_list_plan_mutations", {
			plan_id: planId,
		}, env);
		ctx.assert.gte(Number(mcpMutations.count), 2, "agent_list_plan_mutations returns >=2");

		const mcpChain = await callPlanWorldTool("agent_get_mutation_trace", {
			mutation_id: thuMealId,
		}, env);
		ctx.assert.eq(mcpChain.found, true, "agent_get_mutation_trace finds the meal");
		ctx.assert.eq(Number(mcpChain.chain_length), 2, "chain_length = leaf + 1 ancestor");

		ctx.notes.push(`wed trace: ${wedTraceId}`);
		ctx.notes.push(`thu trace: ${thuChain!.trace.trace_id}`);
		ctx.notes.push(`mutations: ${planMutations.length}, traces: ${planTraces.length}`);
		ctx.notes.push(`thu summary: ${thuChain!.trace.result_summary}`);
	},
};

// ---------------------------------------------------------------------------
// FakeD1 — covers what the MCP write path AND agent-trace read paths need.
// Specifically: mise_active_plans (insert+update), mise_plan_proposals
// (only when legacy preview path runs — not exercised here), and the new
// mise_agent_traces / mise_mutation_traces tables.
// ---------------------------------------------------------------------------

class FakeD1 {
	plans = new Map<string, { plan_json: string; status: string }>();
	traces = new Map<string, AgentTraceRow>();
	mutationTraces = new Map<string, MutationTraceRow>();
	private clock = 0;

	prepare(sql: string): FakeStatement {
		return new FakeStatement(this, sql);
	}
	nextStamp(): string {
		this.clock += 1;
		return new Date(2026, 4, 13, 9, 0, 0, this.clock).toISOString();
	}
}

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

class FakeStatement {
	private bindings: unknown[] = [];

	constructor(private readonly db: FakeD1, private readonly sql: string) {}

	bind(...values: unknown[]): this {
		this.bindings = values;
		return this;
	}

	async run(): Promise<unknown> {
		const sql = this.sql;
		// active plans: INSERT … ON CONFLICT … DO UPDATE.
		if (/INSERT\s+INTO\s+mise_active_plans/i.test(sql)) {
			const planId = String(this.bindings[0]);
			this.db.plans.set(planId, {
				plan_json: String(this.bindings[2]),
				status: String(this.bindings[3]),
			});
			return { success: true };
		}
		if (/UPDATE\s+mise_active_plans/i.test(sql)) {
			// markActivePlanFinal — preserve plan_json, just bump status.
			const planId = String(this.bindings[this.bindings.length - 1]);
			const existing = this.db.plans.get(planId);
			if (existing) {
				this.db.plans.set(planId, { ...existing, status: "finalized" });
			}
			return { success: true };
		}
		if (/DELETE\s+FROM\s+mise_active_plans/i.test(sql)) {
			this.db.plans.delete(String(this.bindings[0]));
			return { success: true };
		}
		// Trace inserts.
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
		// Legacy mise_week_plans save (best-effort) — accept silently.
		if (/INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+mise_week_plans/i.test(sql)) {
			return { success: true };
		}
		// Legacy proposals — not exercised but tolerated.
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
		if (/FROM\s+mise_plan_proposals/i.test(sql)) {
			return null;
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

export default t21;
