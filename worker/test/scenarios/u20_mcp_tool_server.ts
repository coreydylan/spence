// U20 - PlanWorld MCP tool server contract.
//
// Verifies the JSON-RPC surface (tools/list shape, plan_create from intent),
// the new read tools (ledger / grievances / cuisine balance), the fused
// preview+commit write tools (plan_compose_meal), and the lock-aware path
// (plan_lock_meal then plan_swap_ingredient surfaces a warning instead of
// silently mutating the locked slot).

import type { Scenario } from "../lib/types";
import { handlePlanWorldJsonRpc, callPlanWorldTool } from "../../src/mise-graph/plan-world-mcp";

const u20: Scenario = {
	id: "u20",
	name: "PlanWorld MCP tool server exposes the full tool catalog and routes calls",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const env = { DB: new FakeD1() as unknown as D1Database } as any;

		// 1. tools/list returns the full catalog.
		const list = await rpc(env, { id: 1, method: "tools/list", params: {} });
		const toolNames = (list.result?.tools || []).map((tool: any) => tool.name);
		const expected = [
			"plan_create", "plan_get_summary", "plan_finalize", "plan_archive", "plan_list",
			"plan_read_map", "plan_read_empty_slots", "plan_read_meal", "plan_read_ledger_at",
			"plan_read_expiring_by", "plan_read_grievances", "plan_read_recent_meals",
			"plan_read_cuisine_balance", "plan_read_format_balance", "plan_read_batches",
			"plan_read_shopping_list", "plan_read_shop_runs", "plan_read_dependency_edges",
			"plan_read_coherence", "plan_compose_meal", "plan_cancel_meal",
			"plan_swap_ingredient", "plan_move_meal", "plan_replace_meal", "plan_split_batch",
			"plan_move_shop", "plan_slide_prep_date", "plan_lock_meal", "plan_unlock_meal",
			"plan_import_recipe", "plan_assign_recipe", "plan_audit", "plan_score_coherence",
		];
		for (const expectedName of expected) {
			ctx.assert.contains(toolNames, expectedName, `tools/list includes ${expectedName}`);
		}
		ctx.assert.gte(toolNames.length, 30, "tool catalog has at least 30 tools");

		// 2. plan_create from intent (no plan object) returns a plan_id.
		const create = await rpc(env, {
			id: 2,
			method: "tools/call",
			params: {
				name: "plan_create",
				arguments: {
					household_id: "u20_household",
					start_date: "2026-06-01",
					end_date: "2026-06-03",
					people_default: 2,
					ingredients: ["onion", "tomato"],
				},
			},
		});
		const planId = create.result?.structuredContent?.plan_id as string;
		ctx.assert.ok(typeof planId === "string" && planId.length > 0, "plan_create returns a plan_id");
		ctx.assert.gt(create.result?.structuredContent?.empty_slot_count || 0, 0, "fresh plan has empty slots");

		// 3. plan_compose_meal adds a meal and returns grievance diff.
		const compose = await callPlanWorldTool("plan_compose_meal", {
			plan_id: planId,
			slot: { date: "2026-06-01", slot: "dinner" },
			meal: {
				title: "Sheet pan tofu",
				format: "bowl",
				cuisine: ["asian"],
				raw_ingredients: [
					{ name: "tofu", grams: 400 },
					{ name: "rice", grams: 200 },
				],
			},
		}, env);
		ctx.assert.eq(compose.ok, true, "plan_compose_meal succeeds");
		ctx.assert.ok(typeof compose.meal_id === "string", "plan_compose_meal returns a meal_id");
		ctx.assert.ok(Array.isArray(compose.new_grievances), "plan_compose_meal returns new_grievances");
		ctx.assert.ok(Array.isArray(compose.resolved_grievances), "plan_compose_meal returns resolved_grievances");

		// 4. plan_read_grievances returns structured counts.
		const grievances = await callPlanWorldTool("plan_read_grievances", { plan_id: planId }, env);
		ctx.assert.ok(typeof grievances.counts === "object", "plan_read_grievances returns counts");
		ctx.assert.ok(Array.isArray(grievances.grievances), "plan_read_grievances returns grievance array");

		// 5. plan_read_ledger_at exposes resource ledger snapshots.
		const ledger = await callPlanWorldTool("plan_read_ledger_at", {
			plan_id: planId,
			date: "2026-06-01",
		}, env);
		ctx.assert.eq(ledger.date, "2026-06-01", "plan_read_ledger_at echoes date");
		ctx.assert.ok(Array.isArray(ledger.items), "plan_read_ledger_at returns items array");

		// 6. plan_read_cuisine_balance and plan_read_format_balance reflect compose.
		const cuisine = await callPlanWorldTool("plan_read_cuisine_balance", { plan_id: planId }, env);
		ctx.assert.ok(typeof cuisine.cuisine_distribution === "object", "cuisine_distribution is an object");
		const cuisineDist = cuisine.cuisine_distribution as Record<string, number>;
		ctx.assert.gt(cuisineDist.asian || 0, 0, "asian cuisine count incremented after compose");

		const formats = await callPlanWorldTool("plan_read_format_balance", { plan_id: planId }, env);
		const formatDist = formats.format_distribution as Record<string, number>;
		ctx.assert.gt(formatDist.bowl || 0, 0, "bowl format count incremented after compose");

		// 7. plan_lock_meal then plan_swap_ingredient on locked slot returns a warning.
		const lock = await callPlanWorldTool("plan_lock_meal", {
			plan_id: planId,
			slot: { date: "2026-06-01", slot: "dinner" },
			reason: "test pin",
		}, env);
		ctx.assert.eq(lock.locked, true, "plan_lock_meal sets lock");

		const swap = await callPlanWorldTool("plan_swap_ingredient", {
			plan_id: planId,
			slot: { date: "2026-06-01", slot: "dinner" },
			from_name: "tofu",
			to_name: "tempeh",
		}, env);
		ctx.assert.eq(swap.ok, false, "plan_swap_ingredient on locked slot reports failure");
		ctx.assert.eq(swap.error, "locked", "plan_swap_ingredient on locked slot returns locked error");

		// 8. plan_audit returns counts by severity.
		const audit = await callPlanWorldTool("plan_audit", { plan_id: planId, run_critics: "all" }, env);
		ctx.assert.ok(typeof audit.counts === "object", "plan_audit returns counts");
		ctx.assert.ok(Array.isArray(audit.grievances), "plan_audit returns grievances array");

		// 9. unknown tool returns MCP isError result (not a JSON-RPC -32000 envelope).
		const invalidTool = await rpc(env, {
			id: 9,
			method: "tools/call",
			params: { name: "plan_nope_does_not_exist", arguments: {} },
		});
		ctx.assert.eq(invalidTool.result?.isError, true, "unknown tool returns isError result");
		ctx.assert.matches(invalidTool.result?.content?.[0]?.text || "", /plan_nope_does_not_exist|Unknown/i, "isError content names the unknown tool");

		ctx.notes.push(`tool count: ${toolNames.length}`);
		ctx.notes.push(`grievances after compose: ${(grievances.grievances as unknown[]).length}`);
	},
};

async function rpc(env: { DB: D1Database }, request: { id: number; method: string; params: unknown }): Promise<any> {
	return await handlePlanWorldJsonRpc({ jsonrpc: "2.0", ...request }, env as any) as any;
}

class FakeD1 {
	active = new Map<string, { plan_json: string; status: string; household: string | null }>();
	plans = new Map<string, string>(); // legacy mise_week_plans

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
		if (/FROM\s+mise_active_plans/i.test(this.sql)) {
			const row = this.db.active.get(String(this.bindings[0]));
			return (row ? { plan_json: row.plan_json } : null) as T | null;
		}
		if (/FROM\s+mise_week_plans/i.test(this.sql)) {
			const plan_json = this.db.plans.get(String(this.bindings[0]));
			return (plan_json ? { plan_json } : null) as T | null;
		}
		return null;
	}

	async run(): Promise<unknown> {
		// active plan upsert (INSERT ... ON CONFLICT)
		if (/INSERT\s+INTO\s+mise_active_plans/i.test(this.sql)) {
			this.db.active.set(String(this.bindings[0]), {
				household: this.bindings[1] as string | null,
				plan_json: String(this.bindings[2]),
				status: String(this.bindings[3] ?? "draft"),
			});
		} else if (/DELETE\s+FROM\s+mise_active_plans/i.test(this.sql)) {
			this.db.active.delete(String(this.bindings[0]));
		} else if (/INSERT\s+OR\s+REPLACE\s+INTO\s+mise_week_plans/i.test(this.sql)) {
			this.db.plans.set(String(this.bindings[0]), String(this.bindings[11]));
		} else if (/DELETE\s+FROM\s+mise_plan_/i.test(this.sql)) {
			// no-op for legacy archival tables
		} else if (/INSERT\s+OR\s+REPLACE\s+INTO\s+mise_plan_/i.test(this.sql)) {
			// no-op for legacy archival tables
		}
		return { success: true };
	}

	async all<T = unknown>(): Promise<{ results: T[] }> {
		if (/FROM\s+mise_active_plans/i.test(this.sql)) {
			const rows = Array.from(this.db.active.entries()).map(([plan_id, row]) => ({
				plan_id,
				household_id: row.household,
				status: row.status,
				updated_at: "now",
			}));
			return { results: rows as unknown as T[] };
		}
		return { results: [] };
	}
}

export default u20;
