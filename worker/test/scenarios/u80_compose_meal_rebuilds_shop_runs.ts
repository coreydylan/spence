// U80 — plan_compose_meal must rebuild shop_runs + shopping_list after
// inserting a meal. Otherwise the plan ends up with empty shop_runs even
// when meals carry rich raw_ingredients (which is what the live walkthrough
// hit on a "Plan starts today" window — auto-shop never fired).
//
// Mutation-based tools (replace, move, swap) already rebuilt via ripple-
// preview; compose was the lone path that wrote to D1 without rebuild.

import type { Scenario } from "../lib/types";
import { callPlanWorldTool } from "../../src/mise-graph/plan-world-mcp";
import { createMockD1 } from "../lib/mock-d1";

const u80: Scenario = {
	id: "u80",
	name: "plan_compose_meal rebuilds shop_runs + shopping_list",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const env = { DB: createMockD1() } as any;
		await env.DB.prepare(`CREATE TABLE IF NOT EXISTS mise_active_plans (
			plan_id TEXT PRIMARY KEY,
			household_id TEXT,
			plan_json TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'draft',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`).run();
		const planId = "mise_plan:u80_shop_rebuild";
		const slot = { date: "2026-06-10", slot: "dinner" };

		await callPlanWorldTool("plan_create", {
			plan_id: planId, household_id: "hh_u80",
			start_date: slot.date, end_date: slot.date, people_default: 2,
		}, env);

		// Compose a meal with several distinct, shoppable raw_ingredients.
		await callPlanWorldTool("plan_compose_meal", {
			plan_id: planId, slot,
			meal: {
				title: "broccoli stir fry",
				format: "stir_fry",
				cuisine: ["chinese"],
				raw_ingredients: [
					{ name: "broccoli", qty: 400, unit: "g" },
					{ name: "firm tofu", qty: 300, unit: "g" },
					{ name: "soy sauce", qty: 2, unit: "tbsp" },
					{ name: "jasmine rice", qty: 200, unit: "g" },
					{ name: "garlic", qty: 3, unit: "clove" },
					{ name: "ginger", qty: 20, unit: "g" },
					{ name: "scallion", qty: 2, unit: "stalk" },
					{ name: "sesame oil", qty: 1, unit: "tbsp" },
				],
			},
		}, env);

		// shop_runs should now be populated.
		const runs = await callPlanWorldTool("plan_read_shop_runs", { plan_id: planId }, env);
		const list = await callPlanWorldTool("plan_read_shopping_list", { plan_id: planId }, env);

		const runArr = (runs as any).shop_runs ?? [];
		ctx.assert.gt(runArr.length, 0, "compose populated shop_runs");
		ctx.assert.eq(runArr[0].item_count > 0, true, "first run has > 0 items");

		const sections = (list as any).sections ?? [];
		ctx.assert.gt(sections.length, 0, "compose populated shopping_list sections");
		const allItems = sections.flatMap((s: any) => s.items || []);
		const names = new Set(allItems.map((i: any) => (i.name || "").toLowerCase()));
		ctx.assert.ok(names.has("broccoli"), "shopping list contains broccoli");
		ctx.assert.ok(names.has("firm tofu") || names.has("tofu"), "shopping list contains tofu");

		ctx.notes.push(`runs: ${runArr.length}; first: ${runArr[0]?.label}`);
		ctx.notes.push(`shopping sections: ${sections.length}; total items: ${allItems.length}`);
	},
};

export default u80;
