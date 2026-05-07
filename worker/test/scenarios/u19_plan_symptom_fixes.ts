// U19 - regression tests for root causes exposed by real plan snapshots.

import type { Scenario } from "../lib/types";
import { shopFreshnessCritic } from "../../src/mise-graph/critics";
import { deriveDependencyEdges, edgesViolated } from "../../src/mise-graph/dependency-edges";
import { applyComposerPostPass } from "../../src/mise-graph/composer-postpass";
import type { ComposedMeal } from "../../src/mise-graph/menu-composer";
import { planMiseWeek, type MisePlanComponentBatch, type MiseWeeklyPlanDraft } from "../../src/mise-graph/planner";
import { assignDesiredPrepDates } from "../../src/mise-graph/shelf-life-rebatch";

const u19: Scenario = {
	id: "u19",
	name: "planner symptom fixes prevent bogus technique, cuisine, prep-date, and shop freshness failures",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const techniquePlan = await planMiseWeek({
			start_date: "2026-05-11",
			length_days: 2,
			selected_ingredients: ["chickpea"],
			resolved_graph: { techniques: [{ technique: "fermentation" }] },
		}, null, "deterministic");
		const review = techniquePlan.prep_tasks.find(task => task.id.includes("technique_review"));
		ctx.assert.ok(!!review, "planner emits technique review when techniques are present");
		ctx.assert.eq(review!.depends_on.length, 0, "technique review is not modeled as depending on future prep tasks");
		ctx.assert.eq(
			edgesViolated(deriveDependencyEdges(techniquePlan)).filter(edge => edge.id.includes("technique_review")).length,
			0,
			"technique review creates no violated prep-chain edges",
		);
		const generatedMeals = [
			...techniquePlan.meals_by_day.flatMap(day => day.meals),
			...techniquePlan.breakfasts,
		];
		ctx.assert.eq(
			generatedMeals.filter(meal => meal.cuisine.length === 0).length,
			0,
			"planner-level descriptor pass fills cuisine metadata for generated meals",
		);

		const meals = makeComposerMeals();
		const report = applyComposerPostPass(meals, [], {
			formulas: [],
			dietary: ["vegetarian"],
			cuisine_direction: ["Mediterranean"],
			people_default: 2,
		});
		ctx.assert.eq(report.cuisine_filled, 2, "post-pass fills missing cuisine descriptors");
		ctx.assert.eq(meals[1].cuisine[0], "Mediterranean", "leftover lunch inherits dinner cuisine");
		ctx.assert.eq(meals[2].cuisine[0], "California", "breakfast gets a concrete cuisine descriptor");

		const dough = makeDoughBatch();
		assignDesiredPrepDates([dough], "2026-05-11");
		ctx.assert.eq(
			(dough.meta as Record<string, unknown>).desired_prep_date,
			"2026-05-18",
			"make-ahead prep date is capped so last use remains inside shelf window",
		);

		const freshShop = shopFreshnessCritic(makeRefreshShopPlan());
		ctx.assert.eq(freshShop.length, 0, "freshness critic uses the later refresh run when it can carry the item");
	},
};

function makeComposerMeals(): ComposedMeal[] {
	return [
		{
			date: "2026-05-11",
			slot: "dinner",
			title: "Harissa Flatbread With Feta",
			format: "flatbread",
			people: 2,
			cuisine: ["Mediterranean"],
			formula_ids: [],
			raw_ingredients: [],
			notes: [],
			method_summary: "Bake flatbread and save slices for lunch.",
			leftovers_to: ["2026-05-12 lunch"],
			lineage: [],
		},
		{
			date: "2026-05-12",
			slot: "lunch",
			title: "Leftover Harissa Flatbread",
			format: "leftover lunch",
			people: 2,
			cuisine: [],
			formula_ids: [],
			raw_ingredients: [],
			notes: [],
			method_summary: "Reheat slices and add greens.",
			leftovers_to: [],
			lineage: [],
		},
		{
			date: "2026-05-12",
			slot: "breakfast",
			title: "Chia Pudding With Strawberry & Granola",
			format: "breakfast",
			people: 2,
			cuisine: [],
			formula_ids: [],
			raw_ingredients: [],
			notes: [],
			method_summary: "Top chilled chia with fruit.",
			leftovers_to: [],
			lineage: [],
		},
	];
}

function makeDoughBatch(): MisePlanComponentBatch {
	return {
		id: "mise_component:fermented_dough_b2",
		state_id: null,
		label: "Cold-Fermented Dough",
		quantity: 688,
		unit: "g",
		storage: "refrigerator",
		container: null,
		quality_window_hours: 96,
		planned_uses: [
			{ date: "2026-05-20", slot: "dinner", meal_id: "meal:flatbread", title: "Flatbread" },
			{ date: "2026-05-22", slot: "dinner", meal_id: "meal:pizza", title: "Pizza" },
		],
		station_tags: ["dough_fermentation_active"],
		equipment: ["mixing bowl"],
		active_time_min: 20,
		idle_time_min: 2880,
		input_names: ["flour", "water", "yeast", "salt"],
		meta: {
			formula: {
				make_ahead_best_min: 2,
				make_ahead_best_max: 3,
				idle_time_min: 2880,
			},
		},
	};
}

function makeRefreshShopPlan(): MiseWeeklyPlanDraft {
	return {
		id: "mise_plan:u19_refresh",
		household_id: null,
		title: "U19 refresh",
		start_date: "2026-05-11",
		end_date: "2026-05-18",
		timezone: null,
		people: 2,
		status: "draft",
		constraints: {},
		selected_ingredients: [],
		source_recipe_ids: [],
		meals_by_day: [{
			date: "2026-05-18",
			day_index: 7,
			meals: [{
				id: "meal:jalapeno_tacos",
				date: "2026-05-18",
				slot: "dinner",
				title: "Jalapeno Tacos",
				format: "taco",
				component_ids: [],
				ingredient_names: ["jalapeno"],
				source: "synthetic",
				notes: [],
				people: 2,
				cuisine: ["Mexican"],
				locked: false,
				raw_ingredients: [{ name: "jalapeno", qty: 2, unit: "piece", grams: 30, category: "produce" }],
			}],
		}],
		component_batches: [],
		prep_tasks: [],
		breakfasts: [],
		snack_boxes: [],
		shopping_list: [{
			category: "produce",
			items: [{ name: "Jalapeno", quantity: 2, unit: "piece", source: ["Jalapeno Tacos"] }],
		}],
		shop_runs: [
			{ id: "mise_shop_run:2026-05-11:full", date: "2026-05-11", label: "Full shop", categories: ["produce", "pantry"], item_count: 20 },
			{ id: "mise_shop_run:2026-05-18:refresh", date: "2026-05-18", label: "Produce refresh", categories: ["produce"], item_count: 8 },
		],
		storage_labels: [],
		meta: { generated_by: "mise_graph_planner", deterministic: true },
	};
}

export default u19;
