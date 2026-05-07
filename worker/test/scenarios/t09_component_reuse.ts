// T9 — Component reuse beats fresh purchase.
//
// Synthetic Sat pizza + Mon frittata, with a single Sat-prepped dough batch.
// Both formats declare a `bread` slot. After fillComponents runs over the
// meals + the dough batch, Mon's frittata picks up the dough as its `bread`
// component via `source.kind === "use_batch"` — no need to buy sourdough.
// FormatCompositionCritic must emit 0 grievances on the resulting plan.

import type { Scenario } from "../lib/types";
import type { ComposedMeal } from "../../src/mise-graph/menu-composer";
import type { MisePlanComponentBatch, MiseWeeklyPlanDraft, MisePlanMeal } from "../../src/mise-graph/planner";
import { fillComponents } from "../../src/mise-graph/composer-postpass";
import { formatCompositionCritic } from "../../src/mise-graph/critics";
import type { MealComponent } from "../../src/mise-graph/meal-component";

const t09: Scenario = {
	id: "t09",
	name: "Composer reuses Sat dough batch for Mon bread instead of buying sourdough",
	group: "integration",
	tier: "fast",
	async run(ctx) {
		const doughBatch: MisePlanComponentBatch = {
			id: "mise_batch:cold_fermented_dough_001",
			state_id: null, label: "Cold-fermented dough",
			quantity: 1200, unit: "g", storage: "fridge", container: "covered bowl",
			quality_window_hours: 96,
			planned_uses: [{ date: "2026-05-09", slot: "dinner", meal_id: "meal:sat_pizza", title: "Saturday pizza night" }],
			station_tags: [], equipment: ["oven"], active_time_min: 20, idle_time_min: 1440,
			input_names: ["bread flour", "water", "salt", "yeast"],
			meta: { formula_id: "mise_formula_cold_fermented_dough" },
		};
		const satPizza: ComposedMeal = {
			date: "2026-05-09", slot: "dinner", title: "Saturday pizza night", format: "pizza",
			people: 2, cuisine: ["Italian"],
			formula_ids: ["mise_formula_cold_fermented_dough"],
			raw_ingredients: [
				{ name: "fresh mozzarella", qty: 250, unit: "g", grams: 250, category: "dairy" },
				{ name: "tomato sauce", qty: 200, unit: "g", grams: 200, category: "pantry" },
				{ name: "basil", qty: 1, unit: "bunch", grams: 30, category: "herb" },
			],
			notes: [], method_summary: "Stretch dough, top, bake hot.",
			leftovers_to: [], lineage: [],
		};
		const monFrittata: ComposedMeal = {
			date: "2026-05-11", slot: "dinner", title: "Spring vegetable frittata", format: "frittata",
			people: 2, cuisine: [],
			formula_ids: ["mise_formula_cold_fermented_dough"],
			raw_ingredients: [
				{ name: "eggs", qty: 8, unit: "whole", grams: 400, category: "dairy" },
				{ name: "asparagus", qty: 200, unit: "g", grams: 200, category: "produce" },
				{ name: "feta", qty: 100, unit: "g", grams: 100, category: "dairy" },
			],
			notes: [], method_summary: "Bake eggs with vegetables; serve with bread on the side.",
			leftovers_to: [], lineage: [],
		};

		const filledSat = fillComponents(satPizza, [doughBatch]);
		const filledMon = fillComponents(monFrittata, [doughBatch]);
		ctx.notes.push(`fillComponents: pizza=${filledSat} components, frittata=${filledMon} components`);

		const monComponents = (monFrittata as ComposedMeal & { components?: MealComponent[] }).components || [];
		const monBread = monComponents.find(c => c.role === "bread");
		ctx.assert.gte(monComponents.length, 1, "frittata produced at least one component");
		ctx.assert.ok(!!monBread, "frittata's components include a 'bread' role");
		if (monBread) {
			ctx.assert.eq(monBread.source.kind, "use_batch", "Mon bread sourced from a prep batch (not bought)");
			if (monBread.source.kind === "use_batch") {
				ctx.assert.eq(monBread.source.batch_id, doughBatch.id, "Mon bread reuses the Sat dough batch id");
			}
		}
		const satBread = ((satPizza as ComposedMeal & { components?: MealComponent[] }).components || []).find(c => c.role === "bread");
		ctx.assert.ok(!!satBread && satBread.source.kind === "use_batch", "pizza required bread (dough) sourced from batch");

		const plan: MiseWeeklyPlanDraft = {
			id: "fixture_t09", household_id: "test", title: "T9 plan",
			start_date: "2026-05-09", end_date: "2026-05-15", timezone: null, people: 2,
			status: "draft", constraints: {}, selected_ingredients: [], source_recipe_ids: [],
			meals_by_day: [
				{ date: "2026-05-09", day_index: 0, meals: [composedToPlanMeal(satPizza)] },
				{ date: "2026-05-11", day_index: 1, meals: [composedToPlanMeal(monFrittata)] },
			],
			component_batches: [doughBatch], prep_tasks: [], breakfasts: [], snack_boxes: [],
			shopping_list: [], storage_labels: [],
			meta: { generated_by: "mise_graph_planner", deterministic: true },
		};
		const grievances = formatCompositionCritic(plan);
		ctx.notes.push(`format composition grievances: ${grievances.length}`);
		ctx.assert.eq(grievances.length, 0, "format composition critic emits 0 grievances on a fully-composed plan");
	},
};

function composedToPlanMeal(c: ComposedMeal): MisePlanMeal {
	const w = c as ComposedMeal & { components?: MealComponent[] };
	return {
		id: `meal:${c.date}_${c.slot}`, date: c.date, slot: c.slot, title: c.title, format: c.format,
		component_ids: [], ingredient_names: c.raw_ingredients.map(r => r.name),
		source: "test_fixture", notes: c.notes, people: c.people, cuisine: c.cuisine, locked: false,
		raw_ingredients: c.raw_ingredients, method_summary: c.method_summary,
		lineage: c.lineage, leftovers_to: c.leftovers_to, components: w.components,
	};
}

export default t09;
