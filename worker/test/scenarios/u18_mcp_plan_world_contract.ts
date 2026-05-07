// U18 - MCP JSON-RPC contract for PlanWorld tools.

import type { Scenario } from "../lib/types";
import { handlePlanWorldJsonRpc } from "../../src/mise-graph/plan-world-mcp";
import type { MiseWeeklyPlanDraft } from "../../src/mise-graph/planner";

const u18: Scenario = {
	id: "u18",
	name: "PlanWorld MCP JSON-RPC exposes initialize, tools/list, and tools/call",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const env = { DB: new FakeD1() as unknown as D1Database };

		const initialized = await rpc(env, { id: 1, method: "initialize", params: {} });
		ctx.assert.eq(initialized.jsonrpc, "2.0", "initialize returns JSON-RPC response");
		ctx.assert.eq(initialized.result?.serverInfo?.name, "spence-plan-world", "initialize returns server info");

		const list = await rpc(env, { id: 2, method: "tools/list", params: {} });
		const toolNames = (list.result?.tools || []).map((tool: any) => tool.name);
		ctx.assert.contains(toolNames, "plan_read_map", "tools/list includes plan_read_map");
		ctx.assert.contains(toolNames, "plan_apply_mutation", "tools/list includes plan_apply_mutation");
		ctx.assert.contains(toolNames, "plan_finalize", "tools/list includes plan_finalize");

		const invalidMethod = await rpc(env, { id: 3, method: "nope", params: {} });
		ctx.assert.eq(invalidMethod.error?.code, -32601, "unknown method returns JSON-RPC method error");

		const invalidTool = await rpc(env, {
			id: 4,
			method: "tools/call",
			params: { name: "plan_read_summary", arguments: {} },
		});
		// Tool-execution errors land in the MCP result as { isError: true, content: [...] }
		// rather than a JSON-RPC -32000 error envelope. Most MCP clients treat -32000
		// as a transport failure and silently drop it; isError lets the agent read and react.
		ctx.assert.eq(invalidTool.result?.isError, true, "tool validation failures land in result.isError");
		ctx.assert.matches(invalidTool.result?.content?.[0]?.text || "", /plan_read_summary|plan_id/i, "isError content names the tool or missing field");

		const plan = makeMinimalPlan();
		const create = await rpc(env, {
			id: 5,
			method: "tools/call",
			params: { name: "plan_create", arguments: { plan } },
		});
		ctx.assert.eq(create.result?.structuredContent?.plan_id, plan.id, "plan_create returns plan id");
		ctx.assert.eq(create.result?.structuredContent?.summary?.plan_id, plan.id, "plan_create returns summary");

		const map = await rpc(env, {
			id: 6,
			method: "tools/call",
			params: { name: "plan_read_map", arguments: { plan_id: plan.id, mode: "compact" } },
		});
		ctx.assert.contains(map.result?.content?.[0]?.text || "", "# Plan Map", "tools/call content includes map markdown");
		ctx.assert.contains(map.result?.structuredContent?.map || "", "## Coherence Score", "structuredContent includes map");
	},
};

async function rpc(env: { DB: D1Database }, request: { id: number; method: string; params: unknown }): Promise<any> {
	return await handlePlanWorldJsonRpc({ jsonrpc: "2.0", ...request }, env as any) as any;
}

function makeMinimalPlan(): MiseWeeklyPlanDraft {
	return {
		id: "mise_plan:u18",
		household_id: "test",
		title: "U18 MCP fixture",
		start_date: "2026-06-01",
		end_date: "2026-06-01",
		timezone: "UTC",
		people: 2,
		status: "draft",
		constraints: {},
		selected_ingredients: [],
		source_recipe_ids: [],
		meals_by_day: [],
		component_batches: [],
		prep_tasks: [],
		breakfasts: [],
		snack_boxes: [],
		shopping_list: [],
		shop_runs: [],
		storage_labels: [],
		meta: { generated_by: "mise_graph_planner", deterministic: true },
	};
}

class FakeD1 {
	plans = new Map<string, string>();
	proposals = new Map<string, { plan_id: string; status: string; meta_json: string }>();

	prepare(sql: string): FakeStatement {
		return new FakeStatement(this, sql);
	}
}

class FakeStatement {
	private bindings: unknown[] = [];

	constructor(private readonly db: FakeD1, private readonly sql: string) {}

	bind(...values: unknown[]): this {
		this.bindings = values;
		return this;
	}

	async first<T = unknown>(): Promise<T | null> {
		if (/FROM\s+mise_week_plans/i.test(this.sql)) {
			const plan_json = this.db.plans.get(String(this.bindings[0]));
			return (plan_json ? { plan_json } : null) as T | null;
		}
		if (/FROM\s+mise_plan_proposals/i.test(this.sql)) {
			const row = this.db.proposals.get(String(this.bindings[0]));
			if (!row || row.plan_id !== String(this.bindings[1])) return null;
			return { meta_json: row.meta_json } as T;
		}
		return null;
	}

	async run(): Promise<unknown> {
		if (/INSERT\s+OR\s+REPLACE\s+INTO\s+mise_week_plans/i.test(this.sql)) {
			this.db.plans.set(String(this.bindings[0]), String(this.bindings[11]));
		} else if (/INSERT\s+OR\s+REPLACE\s+INTO\s+mise_plan_proposals/i.test(this.sql)) {
			this.db.proposals.set(String(this.bindings[0]), {
				plan_id: String(this.bindings[1]),
				status: String(this.bindings[5]),
				meta_json: String(this.bindings[10]),
			});
		} else if (/UPDATE\s+mise_plan_proposals/i.test(this.sql)) {
			const row = this.db.proposals.get(String(this.bindings[0]));
			if (row && row.plan_id === String(this.bindings[1])) row.status = "applied";
		}
		return { success: true };
	}

	async all(): Promise<{ results: unknown[] }> {
		return { results: [] };
	}
}

export default u18;
