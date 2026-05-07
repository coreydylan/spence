// U37 — Agent trace + replay debug.
//
// Boots an in-memory D1 shim (FakeD1 specifically for the agent-trace
// schema), exercises traced(), linkMutationToTrace(), getTrace(),
// getMutationTrace(), and verifies the parent_trace_id chain is walked
// correctly when calls are nested. Also asserts that traced() captures
// duration_ms, persists ok=true on success and ok=false on thrown errors,
// and that triggered_mutations are recorded on the parent trace row.

import type { Scenario } from "../lib/types";
import {
	beginTrace,
	completeTrace,
	getMutationTrace,
	getTrace,
	linkMutationToTrace,
	listMutationsForPlan,
	listPlanTraces,
	traced,
} from "../../src/mise-graph/agent-trace";

const u37: Scenario = {
	id: "u37",
	name: "Agent trace: traced/begin/complete + mutation linkage + ancestor chain",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const db = new FakeD1();
		const env = { DB: db as unknown as D1Database } as { DB: D1Database };

		// 1. Manual begin/complete round-trip + duration capture.
		const beginCtx = beginTrace({
			tool_name: "plan_compose_meal",
			tool_args: { plan_id: "p1", slot: { date: "2026-05-13", slot: "dinner" } },
			caller_kind: "agent",
			caller_id: "agent-session-1",
			plan_id: "p1",
			household_id: "hh_a",
		});
		ctx.assert.matches(beginCtx.trace_id, /^trace_/, "trace id is namespaced");
		ctx.assert.eq(beginCtx.caller_kind, "agent", "caller_kind round-trips");
		ctx.assert.eq(beginCtx.parent_trace_id, null, "no parent for top-level call");

		// Simulate non-trivial duration so the persisted row has a positive
		// duration_ms — sleeping a few ms is plenty.
		await sleep(5);
		const completed = await completeTrace(env, beginCtx, {
			result: { ok: true, plan_id: "p1", meal_id: "meal:p1:2026-05-13:dinner" },
			result_summary: "compose_meal: meal=meal:p1:2026-05-13:dinner",
			triggered_mutations: [{ kind: "plan_compose_meal", mutation_id: "meal:p1:2026-05-13:dinner" }],
		});
		ctx.assert.eq(completed.trace_id, beginCtx.trace_id, "completeTrace returns same id");

		const fetched = await getTrace(env, beginCtx.trace_id);
		ctx.assert.ok(!!fetched, "trace persisted to D1");
		ctx.assert.eq(fetched!.tool_name, "plan_compose_meal", "tool_name round-trips");
		ctx.assert.eq(fetched!.caller_kind, "agent", "caller_kind round-trips");
		ctx.assert.eq(fetched!.caller_id, "agent-session-1", "caller_id round-trips");
		ctx.assert.eq(fetched!.plan_id, "p1", "plan_id round-trips");
		ctx.assert.eq(fetched!.ok, true, "ok=true on success");
		ctx.assert.gte(fetched!.duration_ms, 1, "duration_ms is captured (>= 1ms)");
		ctx.assert.eq(fetched!.triggered_mutations.length, 1, "triggered_mutations array round-trips");
		ctx.assert.eq(fetched!.triggered_mutations[0].mutation_id, "meal:p1:2026-05-13:dinner", "mutation id round-trips");

		// 2. Link the mutation and read it back via getMutationTrace —
		//    no ancestors yet because there's no parent.
		await linkMutationToTrace(env, {
			mutation_id: "meal:p1:2026-05-13:dinner",
			mutation_kind: "plan_compose_meal",
			plan_id: "p1",
			trace_id: beginCtx.trace_id,
		});

		const reverse = await getMutationTrace(env, "meal:p1:2026-05-13:dinner");
		ctx.assert.ok(!!reverse, "mutation lookup finds trace");
		ctx.assert.eq(reverse!.trace.trace_id, beginCtx.trace_id, "reverse lookup returns the right trace");
		ctx.assert.eq(reverse!.ancestors.length, 0, "top-level trace has no ancestors");

		// 3. traced() convenience wrapper — measures duration even on success.
		const t1 = await traced(env, {
			tool_name: "plan_split_batch",
			tool_args: { plan_id: "p1", batch_id: "batch:dough" },
			caller_kind: "agent",
			plan_id: "p1",
		}, async traceCtx => {
			await sleep(3);
			return {
				result: { ok: true, plan_id: "p1", batch_id: "batch:dough", trace_id: traceCtx.trace_id },
				result_summary: "split_batch: ok",
			};
		});
		ctx.assert.eq(t1.ok, true, "traced() forwards the wrapped result");
		const tracedRow = (await listPlanTraces(env, "p1"))
			.find(r => r.tool_name === "plan_split_batch");
		ctx.assert.ok(!!tracedRow, "traced() persists a row");
		ctx.assert.eq(tracedRow!.ok, true, "traced() persists ok=true on success");

		// 4. traced() on a thrown error — persists ok=false, error message,
		//    and re-throws so the caller still sees the failure.
		let caught: Error | null = null;
		try {
			await traced(env, {
				tool_name: "plan_compose_meal",
				tool_args: { plan_id: "p1" },
				caller_kind: "agent",
				plan_id: "p1",
			}, async () => {
				throw new Error("simulated tool failure");
			});
		} catch (err) {
			caught = err as Error;
		}
		ctx.assert.ok(!!caught && /simulated/.test(caught.message), "traced() rethrows the error");
		const errorRow = (await listPlanTraces(env, "p1"))
			.find(r => r.error && /simulated/.test(r.error));
		ctx.assert.ok(!!errorRow, "error trace was still persisted");
		ctx.assert.eq(errorRow!.ok, false, "error row has ok=false");
		ctx.assert.matches(errorRow!.error || "", /simulated/, "error message round-trips");

		// 5. Nested traces — outer call → inner call → mutation. Walking
		//    getMutationTrace should return [trace, [outer]].
		const outerCtx = beginTrace({
			tool_name: "plan_apply_mutation",
			tool_args: { plan_id: "p2", mutation: { kind: "compose" } },
			caller_kind: "agent",
			plan_id: "p2",
		});
		await sleep(2);
		await completeTrace(env, outerCtx, {
			result: { ok: true, plan_id: "p2", proposal_id: "prop:1" },
			result_summary: "outer ok",
		});

		const innerCtx = beginTrace({
			tool_name: "plan_compose_meal",
			tool_args: { plan_id: "p2" },
			caller_kind: "subagent",
			parent_trace_id: outerCtx.trace_id,
			plan_id: "p2",
		});
		await sleep(2);
		await completeTrace(env, innerCtx, {
			result: { ok: true, plan_id: "p2", meal_id: "meal:p2:dinner" },
			result_summary: "inner ok",
		});

		await linkMutationToTrace(env, {
			mutation_id: "meal:p2:dinner",
			mutation_kind: "plan_compose_meal",
			plan_id: "p2",
			trace_id: innerCtx.trace_id,
		});

		const chain = await getMutationTrace(env, "meal:p2:dinner");
		ctx.assert.ok(!!chain, "nested mutation lookup returns chain");
		ctx.assert.eq(chain!.trace.trace_id, innerCtx.trace_id, "leaf is the inner trace");
		ctx.assert.eq(chain!.trace.parent_trace_id, outerCtx.trace_id, "parent_trace_id captured on inner");
		ctx.assert.eq(chain!.ancestors.length, 1, "ancestor chain has length 1");
		ctx.assert.eq(chain!.ancestors[0].trace_id, outerCtx.trace_id, "ancestor is outer trace");
		ctx.assert.eq(chain!.ancestors[0].caller_kind, "agent", "outer caller_kind round-trips");
		ctx.assert.eq(chain!.trace.caller_kind, "subagent", "inner caller_kind round-trips");

		// 6. Replay listing surfaces.
		const planMutations = await listMutationsForPlan(env, "p2");
		ctx.assert.eq(planMutations.length, 1, "listMutationsForPlan returns p2 mutation");
		ctx.assert.eq(planMutations[0].mutation_id, "meal:p2:dinner", "mutation id round-trips");
		ctx.assert.eq(planMutations[0].trace_id, innerCtx.trace_id, "linked to inner trace");

		const p1Traces = await listPlanTraces(env, "p1");
		ctx.assert.gte(p1Traces.length, 3, "listPlanTraces returns at least the 3 p1 traces");

		// Sanity: not-found returns null, doesn't crash.
		const missing = await getTrace(env, "trace_missing");
		ctx.assert.eq(missing, null, "missing trace returns null");
		const missingMut = await getMutationTrace(env, "meal:nonexistent");
		ctx.assert.eq(missingMut, null, "missing mutation returns null");

		ctx.notes.push(`traces persisted: agent_traces=${db.traces.size} mutation_traces=${db.mutationTraces.size}`);
		ctx.notes.push(`sample trace_id: ${beginCtx.trace_id}`);
		ctx.notes.push(`outer→inner chain id: outer=${outerCtx.trace_id} inner=${innerCtx.trace_id}`);
	},
};

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Fake D1 — supports the agent-trace SQL surface
// ---------------------------------------------------------------------------

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
	traces = new Map<string, AgentTraceRow>();
	mutationTraces = new Map<string, MutationTraceRow>();
	private clock = 0;

	prepare(sql: string): FakeStatement {
		return new FakeStatement(this, sql);
	}
	nextTimestamp(): string {
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
		if (/INSERT\s+INTO\s+mise_agent_traces/i.test(this.sql)) {
			const stamp = this.db.nextTimestamp();
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
				created_at: stamp,  // override with monotonic clock for stable ordering
			});
			return { success: true };
		}
		if (/INSERT\s+OR\s+REPLACE\s+INTO\s+mise_mutation_traces/i.test(this.sql)) {
			const stamp = this.db.nextTimestamp();
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
		return { success: true };
	}

	async first<T = unknown>(): Promise<T | null> {
		if (/FROM\s+mise_agent_traces/i.test(this.sql)) {
			const row = this.db.traces.get(String(this.bindings[0]));
			return (row || null) as T | null;
		}
		if (/FROM\s+mise_mutation_traces/i.test(this.sql)) {
			const row = this.db.mutationTraces.get(String(this.bindings[0]));
			return (row || null) as T | null;
		}
		return null;
	}

	async all<T = unknown>(): Promise<{ results: T[] }> {
		if (/FROM\s+mise_agent_traces[\s\S]+WHERE\s+plan_id\s*=\s*\?/i.test(this.sql)) {
			const planId = String(this.bindings[0]);
			const limit = Number(this.bindings[1]) || 50;
			const matched = Array.from(this.db.traces.values())
				.filter(r => r.plan_id === planId)
				.sort((a, b) => b.created_at.localeCompare(a.created_at))
				.slice(0, limit);
			return { results: matched as unknown as T[] };
		}
		if (/FROM\s+mise_mutation_traces[\s\S]+WHERE\s+plan_id\s*=\s*\?/i.test(this.sql)) {
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

export default u37;
