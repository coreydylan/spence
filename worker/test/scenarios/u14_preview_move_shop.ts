// U14 — previewMoveShop unit tests.
//
// Verifies that previewMoveShop:
//   1. Moving a shop_run earlier than the item's shelf life triggers
//      ShopFreshnessCritic — shows up in new_grievances.
//   2. Moving a shop_run from a too-early date closer to first-use
//      resolves the violation — shows up in resolved_grievances.
//   3. The run's new date is reflected in affected_shopping.runs_changed.
//   4. Missing run_id returns a no-op preview with a warning.

import type { Scenario } from "../lib/types";
import {
	previewMoveShop,
	commit,
	clearProposalCache,
} from "../../src/mise-graph/ripple-preview";
import type {
	MiseWeeklyPlanDraft,
	MisePlanMeal,
} from "../../src/mise-graph/planner";

const u14: Scenario = {
	id: "u14",
	name: "previewMoveShop surfaces ShopFreshnessCritic deltas when run dates change",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// Setup: arugula has a 3-day shelf; Mon dinner uses arugula.
		// Shopping run starts on Sun (1d gap → clean).
		const monday = "2026-05-11";
		const sunday = "2026-05-10";
		const thursday = "2026-05-07";

		// --- Path 1: clean → too-early. Move from Sun to Thu (4d gap). ----------
		clearProposalCache();
		let plan = makePlan(sunday);
		const earlier = previewMoveShop(plan, "mise_shop_run:u14", thursday);

		ctx.notes.push(`earlier warnings: ${earlier.warnings.length}`);
		ctx.notes.push(`earlier new_grievances: ${earlier.new_grievances.length}`);
		ctx.notes.push(`earlier resolved_grievances: ${earlier.resolved_grievances.length}`);

		ctx.assert.eq(earlier.warnings.length, 0, "valid move produces no warnings");
		const newFreshness = earlier.new_grievances.filter(g => g.critic === "ShopFreshnessCritic");
		ctx.assert.gt(newFreshness.length, 0, "moving earlier creates ShopFreshnessCritic violation");
		ctx.assert.matches(newFreshness[0].message, /arugula/i, "violation names arugula");

		// runs_changed reflects the move.
		const moved = earlier.affected_shopping.runs_changed.find(r => r.run_id === "mise_shop_run:u14");
		ctx.assert.ok(!!moved, "run shows up in affected_shopping.runs_changed");
		ctx.assert.eq(moved!.change, "moved", "change is 'moved'");
		ctx.assert.matches(moved!.detail || "", /2026-05-10.*2026-05-07/, "detail captures from→to dates");

		// commit returns post-state with the new date.
		const committed = commit(plan, earlier.proposal_id);
		const movedRun = committed.shop_runs!.find(r => r.id === "mise_shop_run:u14");
		ctx.assert.eq(movedRun!.date, thursday, "commit produces post-state with new date");

		// --- Path 2: too-early → closer. Move from Thu to Sun. ------------------
		clearProposalCache();
		plan = makePlan(thursday);
		const closer = previewMoveShop(plan, "mise_shop_run:u14", sunday);
		ctx.notes.push(`closer new_grievances: ${closer.new_grievances.length}`);
		ctx.notes.push(`closer resolved_grievances: ${closer.resolved_grievances.length}`);

		const resolvedFreshness = closer.resolved_grievances.filter(g => g.critic === "ShopFreshnessCritic");
		ctx.assert.gt(resolvedFreshness.length, 0, "moving closer resolves ShopFreshnessCritic violation");
		ctx.assert.gte(closer.scores.waste_delta, 0, "resolving freshness yields waste_delta ≥ 0");

		// --- Path 3: missing run_id ---------------------------------------------
		clearProposalCache();
		plan = makePlan(sunday);
		const missing = previewMoveShop(plan, "no_such_run", thursday);
		ctx.assert.gt(missing.warnings.length, 0, "missing run_id produces a warning");
		ctx.assert.contains(missing.warnings.join(" "), "not found", "warning mentions 'not found'");

		// --- Path 4: same date (no-op) ------------------------------------------
		clearProposalCache();
		plan = makePlan(sunday);
		const sameDate = previewMoveShop(plan, "mise_shop_run:u14", sunday);
		ctx.assert.gt(sameDate.warnings.length, 0, "moving to current date is a no-op with warning");
	},
};

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function makePlan(shopDate: string): MiseWeeklyPlanDraft {
	const monDinner: MisePlanMeal = makeMeal({
		id: "meal:mon_dinner",
		date: "2026-05-11",
		slot: "dinner",
		title: "Arugula Salad",
		format: "salad",
		ingredient_names: ["arugula", "lemon", "olive oil"],
		raw_ingredients: [
			{ name: "arugula", qty: 100, unit: "g", grams: 100, category: null },
			{ name: "lemon", qty: 1, unit: "piece", grams: 60, category: null },
		],
	});

	return {
		id: "mise_plan:u14",
		household_id: "test",
		title: "U14 fixture",
		start_date: "2026-05-04",
		end_date: "2026-05-11",
		timezone: "UTC",
		people: 2,
		status: "draft",
		constraints: {},
		selected_ingredients: [],
		source_recipe_ids: [],
		meals_by_day: [
			{ date: "2026-05-11", day_index: 7, meals: [monDinner] },
		],
		component_batches: [],
		prep_tasks: [],
		breakfasts: [],
		snack_boxes: [],
		shopping_list: [{
			category: "produce",
			items: [
				{ name: "Arugula", quantity: 1, unit: "bunch", source: ["Arugula Salad"] },
				{ name: "Lemon", quantity: 1, unit: "piece", source: ["Arugula Salad"] },
			],
		}],
		shop_runs: [{
			id: "mise_shop_run:u14",
			date: shopDate,
			label: "Produce shop",
			categories: ["produce"],
			item_count: 2,
		}],
		storage_labels: [],
		meta: { generated_by: "mise_graph_planner", deterministic: true },
	};
}

function makeMeal(partial: Partial<MisePlanMeal> & {
	id: string; date: string; slot: MisePlanMeal["slot"]; title: string;
}): MisePlanMeal {
	return {
		id: partial.id,
		date: partial.date,
		slot: partial.slot,
		title: partial.title,
		format: partial.format ?? "bowl",
		component_ids: partial.component_ids ?? [],
		ingredient_names: partial.ingredient_names ?? [],
		source: partial.source ?? "synthetic_test",
		notes: partial.notes ?? [],
		people: partial.people ?? 2,
		cuisine: partial.cuisine ?? [],
		locked: partial.locked ?? false,
		raw_ingredients: partial.raw_ingredients,
		leftovers_to: partial.leftovers_to,
	};
}

export default u14;
