// U3 — FormatCompositionCritic catches missing required components.
//
// Burger format requires bread (bun) + main (patty). Empty `components: []`
// flags both as missing. Hollow `compose_inline` (zero raw_ingredients) on
// a required slot is also flagged.

import type { Scenario } from "../lib/types";
import type { MiseWeeklyPlanDraft } from "../../src/mise-graph/planner";
import { formatCompositionCritic } from "../../src/mise-graph/critics";

const u03: Scenario = {
	id: "u03",
	name: "FormatCompositionCritic flags burger missing bun + patty components",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const basePlan: MiseWeeklyPlanDraft = {
			id: "fixture_u03", household_id: "test", title: "U3 plan",
			start_date: "2026-05-09", end_date: "2026-05-09", timezone: null, people: 2,
			status: "draft", constraints: {}, selected_ingredients: [], source_recipe_ids: [],
			meals_by_day: [{
				date: "2026-05-09", day_index: 0,
				meals: [{
					id: "meal:test_burger", date: "2026-05-09", slot: "dinner",
					title: "Sad incomplete burger", format: "burger",
					component_ids: [], ingredient_names: [], source: "test_fixture",
					notes: [], people: 2, cuisine: [], locked: false,
					components: [], // explicitly empty — both required slots missing
				}],
			}],
			component_batches: [], prep_tasks: [], breakfasts: [], snack_boxes: [],
			shopping_list: [], storage_labels: [],
			meta: { generated_by: "mise_graph_planner", deterministic: true },
		};

		const grievances = formatCompositionCritic(basePlan);
		ctx.notes.push(`grievances: ${grievances.length}`);
		ctx.assert.gte(grievances.length, 2, "burger missing both bun + patty produces at least 2 grievances");
		ctx.assert.ok(!!grievances.find(g => g.meta?.missing_role === "bread"), "grievance for missing 'bread' (bun)");
		ctx.assert.ok(!!grievances.find(g => g.meta?.missing_role === "main"), "grievance for missing 'main' (patty)");
		for (const g of grievances) {
			ctx.assert.eq(g.severity, "hard", `${g.critic} grievance is severity=hard`);
			ctx.assert.ok(!!g.suggested_repair && g.suggested_repair.length > 10, "grievance includes actionable suggested_repair");
		}

		// Hollow component (compose_inline with empty raw_ingredients) on a required slot is also flagged.
		const planHollow: MiseWeeklyPlanDraft = {
			...basePlan,
			meals_by_day: [{
				date: "2026-05-09", day_index: 0,
				meals: [{
					...basePlan.meals_by_day[0].meals[0],
					components: [
						{ role: "bread", required: true, title: "bun", source: { kind: "compose_inline", raw_ingredients: [] }, serves: 2, active_time_min: 0 },
						{ role: "main",  required: true, title: "patty", source: { kind: "compose_inline", raw_ingredients: [{ name: "lentil patty mix", qty: 400, unit: "g", grams: 400 }] }, serves: 2, active_time_min: 30 },
					],
				}],
			}],
		};
		const hollow = formatCompositionCritic(planHollow);
		ctx.notes.push(`hollow grievances: ${hollow.length}`);
		ctx.assert.eq(hollow.length, 1, "exactly one grievance: the hollow bread component");
		ctx.assert.eq(hollow[0].meta?.hollow, true, "hollow grievance is tagged");
		ctx.assert.eq(hollow[0].meta?.missing_role, "bread", "hollow grievance is for the bread role");
	},
};

export default u03;
