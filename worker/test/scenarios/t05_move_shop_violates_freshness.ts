// T5 — Move shopping trip earlier; freshness critic fires.
//
// Builds a synthetic plan with a Mon dinner that uses arugula (~3d shelf).
// Schedules one shop_run on Sun (1d gap → ok) and asserts the freshness
// critic stays silent. Then moves the shop_run to the previous Thu (4d gap
// → exceeds shelf) and asserts exactly one ShopFreshnessCritic violation
// referencing arugula. Finally moves it back and asserts the violation
// clears.

import type { Scenario } from "../lib/types";
import { shopFreshnessCritic } from "../../src/mise-graph/critics";
import type { MiseWeeklyPlanDraft } from "../../src/mise-graph/planner";

const t05: Scenario = {
	id: "t05",
	name: "Moving a shop run earlier than shelf life triggers ShopFreshnessCritic",
	group: "ripple",
	tier: "fast",
	async run(ctx) {
		const monday = "2026-05-11";
		const sunday = "2026-05-10";
		const thursdayPrior = "2026-05-07";

		// Synthetic plan: Mon dinner uses arugula; everything else minimal.
		const basePlan: MiseWeeklyPlanDraft = {
			id: "test:t05",
			household_id: null,
			title: "T5 freshness",
			start_date: "2026-05-04",
			end_date: "2026-05-11",
			timezone: null,
			people: 2,
			status: "draft",
			constraints: {},
			selected_ingredients: [],
			source_recipe_ids: [],
			meals_by_day: [{
				date: monday,
				day_index: 7,
				meals: [{
					id: "meal:mon-dinner",
					date: monday,
					slot: "dinner",
					title: "Arugula Salad",
					format: "salad",
					component_ids: [],
					ingredient_names: ["arugula", "lemon", "olive oil"],
					source: "synthetic",
					notes: [],
					people: 2,
					cuisine: [],
					locked: false,
				}],
			}],
			component_batches: [],
			prep_tasks: [],
			breakfasts: [],
			snack_boxes: [],
			shopping_list: [{
				category: "produce",
				items: [
					{ name: "Arugula", quantity: 1, unit: "bunch", source: ["Arugula Salad"] },
					{ name: "Lemon", quantity: 2, unit: "piece", source: ["Arugula Salad"] },
				],
			}],
			storage_labels: [],
			meta: { generated_by: "mise_graph_planner", deterministic: true },
		};

		// Case 1: shop_run on Sun (1d gap, well under arugula's 3d shelf) — clean.
		const planSun: MiseWeeklyPlanDraft = {
			...basePlan,
			shop_runs: [{
				id: "mise_shop_run:sun",
				date: sunday,
				label: "Sun shop",
				categories: ["produce"],
				item_count: 2,
			}],
		};
		const cleanGrievances = shopFreshnessCritic(planSun);
		ctx.notes.push(`sun-run violations: ${cleanGrievances.length}`);
		ctx.assert.eq(cleanGrievances.length, 0, "1d gap (Sun→Mon) is within arugula's 3d shelf — no violation");

		// Case 2: move shop_run to prior Thursday (4d gap > 3d shelf).
		const planThursday: MiseWeeklyPlanDraft = {
			...basePlan,
			shop_runs: [{
				id: "mise_shop_run:thu",
				date: thursdayPrior,
				label: "Thu shop",
				categories: ["produce"],
				item_count: 2,
			}],
		};
		const violations = shopFreshnessCritic(planThursday);
		ctx.notes.push(`thu-run violations: ${violations.length}`);
		ctx.assert.eq(violations.length, 1, "4d gap (Thu→Mon) exceeds arugula's 3d shelf — exactly one violation");
		ctx.assert.matches(violations[0].message, /arugula/i, "violation message names arugula");
		ctx.assert.eq(violations[0].critic, "ShopFreshnessCritic", "critic is ShopFreshnessCritic");
		ctx.assert.eq(violations[0].severity, "hard", "severity is hard");

		// Case 3: move it back to Sunday — violation clears.
		const reverted = shopFreshnessCritic(planSun);
		ctx.assert.eq(reverted.length, 0, "moving shop run back to Sun clears the violation");
	},
};

export default t05;
