// T3 — RipplePreview math is correct on cancel_meal.
//
// Builds a synthetic 7-day plan where Wednesday dinner ("Smashburger") uses a
// gochujang_aioli batch (Wed-only consumer) AND kimchi raw_ingredient (also
// used by Sat plans). Thursday lunch claims the smashburger leftover, so
// canceling Wed dinner ripples downstream.
//
// We assert the cross-entity ripple — meals removed + side-effect, batch
// orphaned, shopping list strips Wed-only items but keeps shared items, and
// commit() applies the previewed change.

import type { Scenario } from "../lib/types";
import {
	previewCancelMeal,
	commit,
	clearProposalCache,
} from "../../src/mise-graph/ripple-preview";
import type {
	MiseWeeklyPlanDraft,
	MisePlanMeal,
	MisePlanComponentBatch,
} from "../../src/mise-graph/planner";

const t03: Scenario = {
	id: "t03",
	name: "RipplePreview math correct on cancel_meal (cross-entity ripple)",
	group: "ripple",
	tier: "fast",
	async run(ctx) {
		clearProposalCache();
		const plan = build7DayPlan();

		const preview = previewCancelMeal(plan, { date: "2026-05-13", slot: "dinner" });

		ctx.notes.push(`affected_meals: ${preview.affected_meals.length}`);
		ctx.notes.push(`affected_batches: ${preview.affected_batches.length}`);
		ctx.notes.push(`shopping removed: ${preview.affected_shopping.removed.length}`);
		ctx.notes.push(`shopping added: ${preview.affected_shopping.added.length}`);

		// (1) ≥1 affected meal includes Wed dinner removal.
		ctx.assert.gte(preview.affected_meals.length, 1, "at least one meal change");
		const wedRemoval = preview.affected_meals.find(d => d.meal_id === "meal:wed_dinner" && d.change === "removed");
		ctx.assert.ok(!!wedRemoval, "Wed dinner appears as removed");

		// (2) Thu lunch shows up as side_effect (lost leftover source).
		const thuSideEffect = preview.affected_meals.find(d => d.meal_id === "meal:thu_lunch" && d.change === "side_effect");
		ctx.assert.ok(!!thuSideEffect, "Thu lunch appears as side_effect (leftover source lost)");

		// (3) Gochujang aioli batch is orphaned (its only consumer was Wed dinner).
		const orphanedAioli = preview.affected_batches.find(b => b.batch_id === "mise_component:gochujang_aioli" && b.change === "orphaned");
		ctx.assert.ok(!!orphanedAioli, "gochujang_aioli batch is orphaned");

		// (4) Wed-only items removed; kimchi (still used Sat) NOT in removed list.
		const removedNames = preview.affected_shopping.removed.map(i => i.name.toLowerCase());
		ctx.notes.push(`removed names: ${removedNames.join(", ")}`);
		ctx.assert.ok(removedNames.some(n => n.includes("brioche") || n.includes("bun")), "brioche bun removed");
		ctx.assert.ok(removedNames.some(n => n.includes("bean") && n.includes("patty")), "bean patty removed");
		ctx.assert.ok(!removedNames.some(n => n.includes("kimchi")), "kimchi NOT removed (still used by Sat plans)");

		// (5) Net shopping is smaller after the cancel.
		ctx.assert.gt(
			preview.affected_shopping.removed.length,
			preview.affected_shopping.added.length,
			"more items removed than added — shopping shrinks",
		);

		// (6) Reversible flag.
		ctx.assert.eq(preview.reversible, true, "cancel_meal is reversible");

		// (7) Proposal id present and commit() applies it.
		ctx.assert.ok(preview.proposal_id.length > 0, "proposal_id is non-empty");
		const after = commit(plan, preview.proposal_id);

		// Wed dinner must be gone in the committed plan.
		const wed = after.meals_by_day.find(d => d.date === "2026-05-13");
		const stillThere = wed?.meals.some(m => m.slot === "dinner" && m.id === "meal:wed_dinner");
		ctx.assert.ok(!stillThere, "Wed dinner removed in committed plan");

		// Original plan is untouched.
		const wedOriginal = plan.meals_by_day.find(d => d.date === "2026-05-13");
		const stillThereOriginal = wedOriginal?.meals.some(m => m.slot === "dinner" && m.id === "meal:wed_dinner");
		ctx.assert.ok(!!stillThereOriginal, "original plan still has Wed dinner (immutability)");
	},
};

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

function build7DayPlan(): MiseWeeklyPlanDraft {
	const dates = ["2026-05-11", "2026-05-12", "2026-05-13", "2026-05-14", "2026-05-15", "2026-05-16", "2026-05-17"];

	const monLunch = makeMeal({
		id: "meal:mon_lunch",
		date: dates[0],
		slot: "lunch",
		title: "Mon lunch",
		raw_ingredients: [{ name: "lentil", qty: 200, unit: "g", grams: 200, category: null }],
	});
	const tueDinner = makeMeal({
		id: "meal:tue_dinner",
		date: dates[1],
		slot: "dinner",
		title: "Roast vegetable bowl",
		format: "bowl",
		raw_ingredients: [{ name: "carrot", qty: 300, unit: "g", grams: 300, category: null }],
	});
	const wedDinner = makeMeal({
		id: "meal:wed_dinner",
		date: dates[2],
		slot: "dinner",
		title: "Smashburger",
		format: "burger",
		component_ids: ["mise_component:gochujang_aioli"],
		ingredient_names: ["bean patty", "brioche bun", "kimchi"],
		raw_ingredients: [
			{ name: "bean patty", qty: 4, unit: "piece", grams: 480, category: null },
			{ name: "brioche bun", qty: 4, unit: "piece", grams: 280, category: null },
			{ name: "kimchi", qty: 100, unit: "g", grams: 100, category: null },
		],
		leftovers_to: ["2026-05-14 lunch"],
	});
	const thuLunch = makeMeal({
		id: "meal:thu_lunch",
		date: dates[3],
		slot: "lunch",
		title: "Leftover smashburger lunch",
		format: "sandwich",
		raw_ingredients: [{ name: "lettuce", qty: 100, unit: "g", grams: 100, category: null }],
	});
	const friDinner = makeMeal({
		id: "meal:fri_dinner",
		date: dates[4],
		slot: "dinner",
		title: "Pasta night",
		format: "pasta",
		raw_ingredients: [{ name: "pasta", qty: 400, unit: "g", grams: 400, category: null }],
	});
	const satLunch = makeMeal({
		id: "meal:sat_lunch",
		date: dates[5],
		slot: "lunch",
		title: "Kimchi rice bowl",
		format: "bowl",
		ingredient_names: ["kimchi", "rice"],
		raw_ingredients: [
			{ name: "kimchi", qty: 100, unit: "g", grams: 100, category: null },
			{ name: "rice", qty: 200, unit: "g", grams: 200, category: null },
		],
	});
	const satDinner = makeMeal({
		id: "meal:sat_dinner",
		date: dates[5],
		slot: "dinner",
		title: "Kimchi pancake",
		format: "skillet",
		ingredient_names: ["kimchi", "flour"],
		raw_ingredients: [
			{ name: "kimchi", qty: 150, unit: "g", grams: 150, category: null },
			{ name: "flour", qty: 200, unit: "g", grams: 200, category: null },
		],
	});
	const sunDinner = makeMeal({
		id: "meal:sun_dinner",
		date: dates[6],
		slot: "dinner",
		title: "Soup night",
		format: "soup",
		raw_ingredients: [{ name: "broth", qty: 500, unit: "ml", grams: 500, category: null }],
	});

	const aioliBatch: MisePlanComponentBatch = {
		id: "mise_component:gochujang_aioli",
		state_id: null,
		label: "Gochujang Aioli",
		quantity: 200,
		unit: "g",
		storage: "refrigerator",
		container: "jar",
		quality_window_hours: 96,
		planned_uses: [{ date: dates[2], slot: "dinner", meal_id: "meal:wed_dinner", title: "Smashburger" }],
		station_tags: ["sauce_active"],
		equipment: ["bowl"],
		active_time_min: 8,
		idle_time_min: 0,
		input_names: ["mayo", "gochujang", "garlic"],
		meta: { source: "synthetic_test" },
	};

	return {
		id: "mise_plan:t03_fixture",
		household_id: "test",
		title: "T03 fixture",
		start_date: dates[0],
		end_date: dates[6],
		timezone: "UTC",
		people: 2,
		status: "draft",
		constraints: {},
		selected_ingredients: [],
		source_recipe_ids: [],
		meals_by_day: [
			{ date: dates[0], day_index: 0, meals: [monLunch] },
			{ date: dates[1], day_index: 1, meals: [tueDinner] },
			{ date: dates[2], day_index: 2, meals: [wedDinner] },
			{ date: dates[3], day_index: 3, meals: [thuLunch] },
			{ date: dates[4], day_index: 4, meals: [friDinner] },
			{ date: dates[5], day_index: 5, meals: [satLunch, satDinner] },
			{ date: dates[6], day_index: 6, meals: [sunDinner] },
		],
		component_batches: [aioliBatch],
		prep_tasks: [],
		breakfasts: [],
		snack_boxes: [],
		shopping_list: [],
		shop_runs: [],
		storage_labels: [],
		meta: { generated_by: "mise_graph_planner", deterministic: true },
	};
}

function makeMeal(partial: Partial<MisePlanMeal> & { id: string; date: string; slot: MisePlanMeal["slot"]; title: string }): MisePlanMeal {
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
		leftovers_to: partial.leftovers_to,
		raw_ingredients: partial.raw_ingredients,
	};
}

export default t03;
