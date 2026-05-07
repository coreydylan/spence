// U107 — PantryUnderusedCritic flags meals that don't anchor on existing
// pantry items when the household has ≥10 unique items on the shelf.
//
// The critic is pure: we hand it a plan + a fake HouseholdAuditContext where
// signals.pantry_top has 10+ items. A meal whose raw_ingredients contain
// ZERO pantry items is flagged. A meal that uses any pantry item is NOT.
//
// Edge cases:
//   * Pantry < 10 items → critic skips (insufficient signal).
//   * Meal with no raw_ingredients AND no ingredient_names → skipped (nothing to inspect).

import type { Scenario } from "../lib/types";
import type { MiseWeeklyPlanDraft, MisePlanMeal } from "../../src/mise-graph/planner";
import {
	pantryUnderusedCritic,
	type HouseholdAuditContext,
} from "../../src/mise-graph/household-critics";
import type { HouseholdSignals } from "../../src/mise-graph/household-signals";

function makeMeal(id: string, title: string, ingredient_names: string[]): MisePlanMeal {
	return {
		id,
		date: "2026-05-08",
		slot: "dinner",
		title,
		format: "bowl",
		component_ids: [],
		ingredient_names,
		source: "test_fixture",
		notes: [],
		people: 2,
		cuisine: [],
		locked: false,
	};
}

function makePlan(meals: MisePlanMeal[]): MiseWeeklyPlanDraft {
	return {
		id: "fixture_u107",
		household_id: "hh_u107",
		title: "U107 plan",
		start_date: "2026-05-08",
		end_date: "2026-05-08",
		timezone: null,
		people: 2,
		status: "draft",
		constraints: {},
		selected_ingredients: [],
		source_recipe_ids: [],
		meals_by_day: [{ date: "2026-05-08", day_index: 0, meals }],
		component_batches: [],
		prep_tasks: [],
		breakfasts: [],
		snack_boxes: [],
		shopping_list: [],
		storage_labels: [],
		meta: { generated_by: "mise_graph_planner", deterministic: true },
	};
}

function makeContext(pantryItems: string[]): HouseholdAuditContext {
	const signals: HouseholdSignals = {
		household_id: "hh_u107",
		generated_at_ms: Date.now(),
		personality: { summary: "", dimensions: [] },
		traditions: [],
		pantry_top: [{ category: "pantry", items: pantryItems }],
		equipment_available: [],
		avoidances: { dietary: [], allergies: [], dislikes: [] },
		member_spread_guidance: null,
	};
	return { household_id: "hh_u107", signals, traditions: [] };
}

const u107: Scenario = {
	id: "u107",
	name: "PantryUnderusedCritic flags meals that ignore a stocked pantry",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const pantry10 = [
			"chickpeas", "olive oil", "tahini", "cumin", "lentils",
			"garlic", "lemon", "feta", "rice", "yogurt",
		];

		// 1. VIOLATION — meal uses none of the pantry items.
		const ignoresMeal = makeMeal("meal:ignores", "Sushi rolls", ["nori", "ahi tuna", "wasabi", "soy sauce"]);
		const usesMeal = makeMeal("meal:uses", "Lemon-tahini bowl", ["chickpeas", "lemon", "kale"]);
		const plan = makePlan([ignoresMeal, usesMeal]);
		const context = makeContext(pantry10);

		const grievances = pantryUnderusedCritic(plan, context);
		ctx.assert.eq(grievances.length, 1, "exactly one preference grievance for the meal that ignores pantry");
		const g = grievances[0];
		ctx.assert.eq(g.critic, "PantryUnderusedCritic", "critic name");
		ctx.assert.eq(g.severity, "preference", "severity is preference");
		ctx.assert.contains(g.message, "Sushi rolls", "message names the offending meal");
		ctx.assert.contains(g.message, "0 items", "message highlights zero pantry usage");
		ctx.assert.contains(g.suggested_repair || "", "chickpeas", "repair lists top pantry items");
		const meta = g.meta as Record<string, unknown>;
		ctx.assert.eq(meta?.pantry_count, 10, "meta.pantry_count carries");

		// 2. PANTRY < 10 — critic skips (insufficient signal).
		const smallContext = makeContext(["chickpeas", "olive oil", "tahini"]);
		const smallResult = pantryUnderusedCritic(plan, smallContext);
		ctx.assert.eq(smallResult.length, 0, "pantry < 10 items → critic skipped");

		// 3. ALL meals use pantry → 0 grievances.
		const onlyUsersPlan = makePlan([usesMeal]);
		const onlyUsersResult = pantryUnderusedCritic(onlyUsersPlan, context);
		ctx.assert.eq(onlyUsersResult.length, 0, "every meal uses pantry → 0 grievances");

		// 4. Meal with no ingredient_names AND no raw_ingredients → skipped (nothing to inspect).
		const blankMeal = makeMeal("meal:blank", "TBD", []);
		const blankPlan = makePlan([blankMeal]);
		const blankResult = pantryUnderusedCritic(blankPlan, context);
		ctx.assert.eq(blankResult.length, 0, "meal with empty ingredient list is skipped (no signal)");

		// 5. raw_ingredients also count: meal with raw_ingredients[]={olive oil}
		// should be honored even when ingredient_names is empty.
		const rawOnlyMeal: MisePlanMeal = {
			...makeMeal("meal:raw_only", "Olive oil drizzle", []),
			raw_ingredients: [{ name: "olive oil", qty: 30, unit: "ml", grams: 27, category: "pantry" }],
		};
		const rawOnlyPlan = makePlan([rawOnlyMeal]);
		const rawOnlyResult = pantryUnderusedCritic(rawOnlyPlan, context);
		ctx.assert.eq(rawOnlyResult.length, 0, "raw_ingredients counts as pantry-use signal");

		ctx.notes.push(`u107 violating meal flagged: ${g.slot_ref?.date} ${g.slot_ref?.slot}`);
	},
};

export default u107;
