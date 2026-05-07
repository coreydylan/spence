// U26 — buildDailyBriefContext projects a focused per-day situation.
//
// Synthesizes a small plan with a Tuesday dinner, a hummus prep session,
// an expiring shiitake batch (turns the next day), and asserts the
// resulting DailyBriefContext fields are populated correctly.

import type { Scenario } from "../lib/types";
import { buildDailyBriefContext, briefContextHasSignal } from "../../src/mise-graph/daily-brief";
import type {
	MiseWeeklyPlanDraft,
	MisePlanComponentBatch,
	MisePlanMeal,
	MisePlanTask,
} from "../../src/mise-graph/planner";

const u26: Scenario = {
	id: "u26",
	name: "buildDailyBriefContext surfaces today's meals, cooks, expiring items, grievances",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const plan = makePlan();
		const out = buildDailyBriefContext(plan, "2026-05-12");

		// --- header ---
		ctx.assert.eq(out.household_id, "hh_test", "household_id propagated");
		ctx.assert.eq(out.plan_id, "mise_plan:u26", "plan_id propagated");
		ctx.assert.eq(out.for_date, "2026-05-12", "for_date echoed");

		// --- today's meals ---
		ctx.assert.eq(out.todays_meals.length, 1, "exactly one meal scheduled today");
		const dinner = out.todays_meals[0];
		ctx.assert.eq(dinner.slot, "dinner", "dinner slot picked up");
		ctx.assert.eq(dinner.title, "Pad Thai", "dinner title surfaced");
		ctx.assert.contains(dinner.cuisine, "thai", "cuisine list surfaced");
		ctx.assert.eq(dinner.format, "noodle bowl", "format surfaced");
		ctx.assert.contains(dinner.component_uses, "Hummus batch", "component_uses includes the batch label");

		// --- today's cooks ---
		ctx.assert.eq(out.todays_cooks.length, 1, "one cook session scheduled today");
		const cook = out.todays_cooks[0];
		ctx.assert.contains(cook.title.toLowerCase(), "hummus", "cook title mentions hummus");
		ctx.assert.eq(cook.active_min, 25, "active_min summed across the session");
		ctx.assert.gte(cook.idle_min, 0, "idle_min populated");

		// --- expiring items (shiitake, expires 2026-05-13 = 1 day away) ---
		const shiitake = out.expiring_items.find(i => i.canonical_name.includes("shiitake"));
		ctx.assert.ok(!!shiitake, "shiitake surfaced as expiring");
		if (shiitake) {
			ctx.assert.lte(shiitake.days_until, 2, "shiitake days_until within threshold");
			ctx.assert.eq(shiitake.expires_at, "2026-05-13", "shiitake expires_at echoed");
		}

		// --- upcoming grievances (just verify the bucket is well-formed) ---
		ctx.assert.ok(Array.isArray(out.upcoming_grievances), "upcoming_grievances is an array");

		// --- briefContextHasSignal sanity ---
		ctx.assert.ok(briefContextHasSignal(out), "context has signal (not a no-op day)");

		// Empty-day check: a date outside the plan's window has no meals/cooks.
		const empty = buildDailyBriefContext(plan, "2026-05-20");
		ctx.assert.eq(empty.todays_meals.length, 0, "no meals on a date with no scheduled food");
		ctx.assert.eq(empty.todays_cooks.length, 0, "no cooks on an empty date");

		ctx.notes.push(`u26: ${out.todays_meals.length} meals, ${out.todays_cooks.length} cooks, ${out.expiring_items.length} expiring`);
	},
};

function makePlan(): MiseWeeklyPlanDraft {
	const dinnerTuesday: MisePlanMeal = {
		id: "meal:tue_dinner",
		date: "2026-05-12",
		slot: "dinner",
		title: "Pad Thai",
		format: "noodle bowl",
		component_ids: ["batch:hummus"],
		ingredient_names: ["shiitake mushroom", "rice noodle", "tamarind"],
		source: "test",
		notes: [],
		people: 2,
		cuisine: ["thai"],
		locked: false,
		raw_ingredients: [
			{ name: "shiitake mushroom", qty: 200, unit: "g", grams: 200 },
			{ name: "rice noodle", qty: 200, unit: "g", grams: 200 },
		],
	};
	const dinnerWednesday: MisePlanMeal = {
		id: "meal:wed_dinner",
		date: "2026-05-13",
		slot: "dinner",
		title: "Mezze Plate",
		format: "plate",
		component_ids: ["batch:hummus"],
		ingredient_names: ["pita", "cucumber"],
		source: "test",
		notes: [],
		people: 2,
		cuisine: ["mediterranean"],
		locked: false,
		raw_ingredients: [],
	};

	const hummusBatch: MisePlanComponentBatch = {
		id: "batch:hummus",
		state_id: null,
		label: "Hummus batch",
		quantity: 600,
		unit: "g",
		storage: "fridge",
		container: "deli quart",
		quality_window_hours: 96,
		planned_uses: [
			{ date: "2026-05-12", slot: "dinner", meal_id: "meal:tue_dinner", title: "Pad Thai" },
			{ date: "2026-05-13", slot: "dinner", meal_id: "meal:wed_dinner", title: "Mezze Plate" },
		],
		station_tags: ["counter"],
		equipment: ["food processor"],
		active_time_min: 25,
		idle_time_min: 30,
		input_names: ["chickpea", "tahini"],
		meta: { desired_prep_date: "2026-05-12" },
	};

	const hummusTask: MisePlanTask = {
		id: "task:hummus",
		scheduled_date: "2026-05-12",
		session_order: 0,
		task_type: "component_prep",
		title: "Make hummus",
		station_tags: ["morning"],
		equipment: ["food processor"],
		depends_on: [],
		state_inputs: [],
		state_outputs: [],
		active_time_min: 25,
		idle_time_min: 30,
		instructions: ["Soak chickpeas overnight.", "Blend with tahini and lemon."],
		status: "planned",
		meta: {},
	};

	// Stand-in for "shiitake from Sunday" — a batch produced 2026-05-11 with
	// a 48h shelf life (expires 2026-05-13) and a planned use on Wednesday so
	// stock is on hand on Tuesday morning (= for_date) and surfaces as
	// expiring within the 2-day threshold.
	const shiitakeBatch: MisePlanComponentBatch = {
		id: "batch:shiitake",
		state_id: null,
		label: "shiitake mushroom",
		quantity: 250,
		unit: "g",
		storage: "fridge",
		container: "deli pint",
		quality_window_hours: 48,
		planned_uses: [
			{ date: "2026-05-13", slot: "dinner", meal_id: "meal:wed_dinner", title: "Mezze Plate" },
		],
		station_tags: [],
		equipment: [],
		active_time_min: 0,
		idle_time_min: 0,
		input_names: [],
		meta: { desired_prep_date: "2026-05-11" },
	};

	return {
		id: "mise_plan:u26",
		household_id: "hh_test",
		title: "U26 fixture",
		start_date: "2026-05-11",
		end_date: "2026-05-17",
		timezone: "America/Los_Angeles",
		people: 2,
		status: "draft",
		constraints: {},
		selected_ingredients: [],
		source_recipe_ids: [],
		meals_by_day: [
			{ date: "2026-05-11", day_index: 0, meals: [] },
			{ date: "2026-05-12", day_index: 1, meals: [dinnerTuesday] },
			{ date: "2026-05-13", day_index: 2, meals: [dinnerWednesday] },
		],
		component_batches: [hummusBatch, shiitakeBatch],
		prep_tasks: [hummusTask],
		breakfasts: [],
		snack_boxes: [],
		shopping_list: [],
		shop_runs: [],
		storage_labels: [],
		meta: { generated_by: "mise_graph_planner", deterministic: true },
	};
}

export default u26;
