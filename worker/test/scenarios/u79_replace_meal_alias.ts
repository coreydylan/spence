// U79 — plan_replace_meal accepts `meal` as alias for `new_meal`, and
// surfaces a helpful error when neither is provided.
//
// Regression from the live walkthrough: I (the agent) passed `meal` to
// plan_replace_meal because plan_compose_meal uses that key. The handler
// silently took `args.new_meal` (undefined) and the underlying preview
// returned an unchanged plan — the replace looked like a no-op with no
// indication of what went wrong. Now both keys work; missing both throws.

import type { Scenario } from "../lib/types";
import { _mcpInternals, callPlanWorldTool } from "../../src/mise-graph/plan-world-mcp";
import { createMockD1 } from "../lib/mock-d1";

const u79: Scenario = {
	id: "u79",
	name: "plan_replace_meal accepts `meal` alias + clear error when neither key given",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const env = { DB: createMockD1() } as any;
		// Compose-meal needs the active-plans table; create it explicitly.
		await env.DB.prepare(`CREATE TABLE IF NOT EXISTS mise_active_plans (
			plan_id TEXT PRIMARY KEY,
			household_id TEXT,
			plan_json TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'draft',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`).run();
		const planId = "mise_plan:u79_replace_alias";
		const slot = { date: "2026-06-01", slot: "dinner" };

		// Set up: create plan + compose initial meal
		await callPlanWorldTool("plan_create", {
			plan_id: planId, household_id: "hh_u79",
			start_date: slot.date, end_date: slot.date, people_default: 2,
		}, env);
		await callPlanWorldTool("plan_compose_meal", {
			plan_id: planId, slot,
			meal: { title: "original meal", format: "salad", cuisine: ["test"], raw_ingredients: [{ name: "lettuce", qty: 200, unit: "g" }] },
		}, env);

		// 1. Calling plan_replace_meal with `meal` (the alias) should work,
		//    not silently no-op like it did during the walkthrough.
		const aliasResult = await callPlanWorldTool("plan_replace_meal", {
			plan_id: planId, slot,
			meal: { title: "replaced via alias", format: "salad", cuisine: ["test"], raw_ingredients: [{ name: "kale", qty: 200, unit: "g" }] },
		}, env);
		ctx.assert.ok(aliasResult.ok !== false, "replace via `meal` alias succeeds");

		const after1 = await callPlanWorldTool("plan_read_meal", { plan_id: planId, slot }, env);
		ctx.assert.eq((after1.meal as any)?.title, "replaced via alias", "title is the alias-passed value");
		// Regression check: plan_read_meal now exposes components (the view used
		// to strip them, which made post-walkthrough debugging impossible).
		ctx.assert.ok(Array.isArray((after1.meal as any)?.components), "plan_read_meal surfaces components array");
		ctx.assert.ok(Array.isArray((after1.meal as any)?.cuisine), "plan_read_meal surfaces cuisine array");
		ctx.assert.eq((after1.meal as any)?.people, 2, "plan_read_meal surfaces people count");

		// 2. The canonical `new_meal` key still works (no regression).
		const canonicalResult = await callPlanWorldTool("plan_replace_meal", {
			plan_id: planId, slot,
			new_meal: { title: "replaced via canonical", format: "salad", cuisine: ["test"], raw_ingredients: [{ name: "spinach", qty: 200, unit: "g" }] },
		}, env);
		ctx.assert.ok(canonicalResult.ok !== false, "replace via canonical `new_meal` succeeds");
		const after2 = await callPlanWorldTool("plan_read_meal", { plan_id: planId, slot }, env);
		ctx.assert.eq((after2.meal as any)?.title, "replaced via canonical", "canonical-key replace lands");

		// 3. With NEITHER key, the tool surfaces a clear error via isError —
		//    no more silent no-op.
		const missing = await _mcpInternals.handleToolCall(
			{ name: "plan_replace_meal", arguments: { plan_id: planId, slot } },
			env,
		);
		ctx.assert.eq((missing as any).isError, true, "missing meal arg → isError");
		ctx.assert.matches((missing as any).content[0].text, /new_meal|meal/i, "error names the missing field");
	},
};

export default u79;
