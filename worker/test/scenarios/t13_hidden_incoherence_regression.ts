// T13 - hidden incoherence regression.
//
// This fixture is shaped like the real failure mode that prompted the agentic
// turn: it satisfies the old broad structural assertions (enough dinners,
// varied formats, leftovers declared, component references present), but the
// calendar is globally incoherent. The new acceptance layer must catch that.

import type { Scenario } from "../lib/types";
import { renderPlanMap } from "../../src/mise-graph/plan-map-renderer";
import { scorePlanCoherence } from "../../src/mise-graph/coherence-score";
import type {
	MiseMealSlot,
	MisePlanComponentBatch,
	MisePlanMeal,
	MisePlanTask,
	MiseWeeklyPlanDraft,
} from "../../src/mise-graph/planner";

const t13: Scenario = {
	id: "t13",
	name: "hidden incoherence fails coherence even when legacy shape checks pass",
	group: "adversarial",
	tier: "fast",
	async run(ctx) {
		const plan = makeHiddenIncoherencePlan();
		const dinners = plan.meals_by_day.flatMap(day => day.meals).filter(meal => meal.slot === "dinner");

		ctx.assert.eq(dinners.length, 7, "legacy shape: 7 dinners present");
		ctx.assert.gte(new Set(dinners.map(meal => meal.format)).size, 5, "legacy shape: dinner format diversity looks healthy");
		ctx.assert.gte(dinners.filter(meal => (meal.leftovers_to || []).length > 0).length, 4, "legacy shape: enough dinners declare leftovers");
		ctx.assert.gte(
			dinners.filter(meal => (meal.component_ids || []).length > 0).length / dinners.length,
			0.5,
			"legacy shape: at least half of dinners reference component batches",
		);
		const nonVeg = /fish sauce|anchov|oyster sauce|chicken|beef|pork|bacon|salmon|tuna|prawn|shrimp/i;
		const dietaryViolations = dinners.flatMap(meal => (meal.raw_ingredients || []).filter(ing => nonVeg.test(ing.name || "")));
		ctx.assert.eq(dietaryViolations.length, 0, "legacy shape: dinners are vegetarian by raw ingredient names");

		const coherence = scorePlanCoherence(plan);
		const map = renderPlanMap(plan);
		ctx.notes.push(`coherence score: ${coherence.score}`);
		ctx.notes.push(`issues: ${coherence.issues.map(issue => issue.kind).join(", ")}`);

		ctx.assert.gte(coherence.score, 70, "new acceptance: hidden incoherence scores badly");
		ctx.assert.ok(coherence.edge_violation_count > 0, "new acceptance: impossible dough lead time is counted");
		ctx.assert.ok(coherence.duplicate_title_issues.some(issue => issue.kind === "duplicate_exact_meal_title"), "new acceptance: duplicate meal title is caught");
		ctx.assert.ok(coherence.leftover_issues.some(issue => issue.kind === "reverse_time_leftover_claim"), "new acceptance: backward leftover claim is caught");
		ctx.assert.ok(coherence.prep_batch_issues.some(issue => issue.kind === "redundant_prep_batch"), "new acceptance: redundant prep is caught");
		ctx.assert.ok(coherence.missing_descriptor_issues.some(issue => issue.kind === "missing_cuisine"), "new acceptance: placeholder metadata is caught");

		ctx.assert.contains(map, "## Coherence Score", "map exposes coherence score in one read");
		ctx.assert.contains(map, "duplicate_exact_meal_title", "map exposes duplicate title issue");
		ctx.assert.contains(map, "reverse_time_leftover_claim", "map exposes backward leftover issue");
		ctx.assert.contains(map, "redundant_prep_batch", "map exposes redundant prep issue");
		ctx.assert.contains(map, "rule=min_lead_time:48h", "map exposes dough lead-time violation");
	},
};

function makeHiddenIncoherencePlan(): MiseWeeklyPlanDraft {
	const monDinner = makeMeal({
		id: "meal:mon_dinner",
		date: "2026-05-11",
		slot: "dinner",
		title: "Gochujang Shiitake Pizza",
		format: "pizza",
		cuisine: ["korean-italian"],
		component_ids: ["batch:cold_ferment_dough"],
		raw_ingredients: [{ name: "shiitake mushroom", qty: 250, unit: "g", grams: 250, category: "produce" }],
		leftovers_to: ["2026-05-12 lunch"],
	});
	const tueLunch = makeMeal({
		id: "meal:tue_lunch",
		date: "2026-05-12",
		slot: "lunch",
		title: "Chard Frittata Leftover",
		format: "frittata",
		cuisine: [],
		leftovers_to: ["2026-05-11 lunch"],
	});
	const tueDinner = makeMeal({
		id: "meal:tue_dinner",
		date: "2026-05-12",
		slot: "dinner",
		title: "Chard Frittata",
		format: "frittata",
		cuisine: ["mediterranean"],
		component_ids: ["batch:herb_yogurt"],
		leftovers_to: ["2026-05-13 lunch"],
	});
	const wedDinner = makeMeal({
		id: "meal:wed_dinner",
		date: "2026-05-13",
		slot: "dinner",
		title: "Mushroom Banh Mi",
		format: "sandwich",
		cuisine: ["vietnamese-french"],
		leftovers_to: ["2026-05-14 lunch"],
	});
	const thuDinner = makeMeal({
		id: "meal:thu_dinner",
		date: "2026-05-14",
		slot: "dinner",
		title: "Bean Smashburger",
		format: "burger",
		cuisine: ["korean-mexican"],
		component_ids: ["batch:herb_yogurt"],
	});
	const friDinner = makeMeal({
		id: "meal:fri_dinner",
		date: "2026-05-15",
		slot: "dinner",
		title: "Levantine Mezze Platter",
		format: "mezze",
		cuisine: ["levantine"],
		component_ids: ["batch:hummus_a"],
		leftovers_to: ["2026-05-16 lunch"],
	});
	const satDinner = makeMeal({
		id: "meal:sat_dinner",
		date: "2026-05-16",
		slot: "dinner",
		title: "Curried Eggplant and Rice",
		format: "curry",
		cuisine: ["indian"],
		component_ids: ["batch:hummus_b"],
	});
	const sunLunch = makeMeal({
		id: "meal:sun_lunch",
		date: "2026-05-17",
		slot: "lunch",
		title: "Miso Butter Mushroom Risotto",
		format: "",
		cuisine: [],
	});
	const sunDinner = makeMeal({
		id: "meal:sun_dinner",
		date: "2026-05-17",
		slot: "dinner",
		title: "Miso Butter Mushroom Risotto",
		format: "risotto",
		cuisine: ["italian-japanese"],
		component_ids: ["batch:herb_yogurt"],
		leftovers_to: ["2026-05-18 lunch"],
	});

	return {
		id: "mise_plan:t13_hidden",
		household_id: "test",
		title: "T13 Hidden Incoherence Fixture",
		start_date: "2026-05-11",
		end_date: "2026-05-17",
		timezone: "UTC",
		people: 2,
		status: "draft",
		constraints: { dietary: ["vegetarian"] },
		selected_ingredients: ["shiitake", "chard", "hummus"],
		source_recipe_ids: [],
		meals_by_day: [
			{ date: "2026-05-11", day_index: 0, meals: [monDinner] },
			{ date: "2026-05-12", day_index: 1, meals: [tueLunch, tueDinner] },
			{ date: "2026-05-13", day_index: 2, meals: [wedDinner] },
			{ date: "2026-05-14", day_index: 3, meals: [thuDinner] },
			{ date: "2026-05-15", day_index: 4, meals: [friDinner] },
			{ date: "2026-05-16", day_index: 5, meals: [satDinner] },
			{ date: "2026-05-17", day_index: 6, meals: [sunLunch, sunDinner] },
		],
		component_batches: [
			makeBatch({
				id: "batch:cold_ferment_dough",
				label: "48h Cold Ferment Dough",
				quality_window_hours: 120,
				idle_time_min: 2880,
				prep_date: "2026-05-11",
				planned_uses: [{ date: "2026-05-11", slot: "dinner", meal_id: monDinner.id, title: monDinner.title }],
			}),
			makeBatch({
				id: "batch:hummus_a",
				label: "Hummus",
				quality_window_hours: 96,
				prep_date: "2026-05-11",
				planned_uses: [{ date: "2026-05-15", slot: "dinner", meal_id: friDinner.id, title: friDinner.title }],
			}),
			makeBatch({
				id: "batch:hummus_b",
				label: "Hummus Batch",
				quality_window_hours: 96,
				prep_date: "2026-05-12",
				planned_uses: [{ date: "2026-05-16", slot: "dinner", meal_id: satDinner.id, title: satDinner.title }],
			}),
			makeBatch({
				id: "batch:herb_yogurt",
				label: "Herb Yogurt Sauce",
				quality_window_hours: 96,
				prep_date: "2026-05-12",
				planned_uses: [
					{ date: "2026-05-12", slot: "dinner", meal_id: tueDinner.id, title: tueDinner.title },
					{ date: "2026-05-14", slot: "dinner", meal_id: thuDinner.id, title: thuDinner.title },
				],
			}),
		],
		prep_tasks: [
			makeTask("task:dough", "2026-05-11", "batch:cold_ferment_dough", 2880),
			makeTask("task:hummus_a", "2026-05-11", "batch:hummus_a"),
			makeTask("task:hummus_b", "2026-05-12", "batch:hummus_b"),
			makeTask("task:herb_yogurt", "2026-05-12", "batch:herb_yogurt"),
		],
		breakfasts: [],
		snack_boxes: [],
		shopping_list: [
			{ category: "pantry", items: [{ name: "flour", quantity: 1, unit: "bag", source: ["batch:cold_ferment_dough"] }] },
			{ category: "produce", items: [{ name: "shiitake mushroom", quantity: 250, unit: "g", source: [monDinner.id], grams_total: 250 }] },
		],
		shop_runs: [
			{ id: "shop:mon", date: "2026-05-11", label: "Monday shop", categories: ["pantry", "produce"], item_count: 2 },
		],
		storage_labels: [],
		meta: { generated_by: "mise_graph_planner", deterministic: true },
	};
}

function makeMeal(partial: Partial<MisePlanMeal> & { id: string; date: string; slot: MiseMealSlot; title: string }): MisePlanMeal {
	return {
		id: partial.id,
		date: partial.date,
		slot: partial.slot,
		title: partial.title,
		format: partial.format ?? "bowl",
		component_ids: partial.component_ids ?? [],
		ingredient_names: partial.ingredient_names ?? [],
		source: "synthetic_test",
		notes: partial.notes ?? [],
		people: partial.people ?? 2,
		cuisine: partial.cuisine ?? ["test"],
		locked: false,
		raw_ingredients: partial.raw_ingredients,
		leftovers_to: partial.leftovers_to,
	};
}

function makeBatch(args: {
	id: string;
	label: string;
	quality_window_hours: number;
	idle_time_min?: number;
	prep_date: string;
	planned_uses: MisePlanComponentBatch["planned_uses"];
}): MisePlanComponentBatch {
	return {
		id: args.id,
		state_id: null,
		label: args.label,
		quantity: 1,
		unit: "batch",
		storage: "refrigerator",
		container: null,
		quality_window_hours: args.quality_window_hours,
		planned_uses: args.planned_uses,
		station_tags: [],
		equipment: [],
		active_time_min: 15,
		idle_time_min: args.idle_time_min ?? 0,
		input_names: [],
		meta: { desired_prep_date: args.prep_date },
	};
}

function makeTask(id: string, date: string, output: string, idle = 0): MisePlanTask {
	return {
		id,
		scheduled_date: date,
		session_order: 0,
		task_type: "component_prep",
		title: `Prep ${output}`,
		station_tags: [],
		equipment: [],
		depends_on: [],
		state_inputs: [],
		state_outputs: [output],
		active_time_min: 15,
		idle_time_min: idle,
		instructions: [],
		status: "planned",
		meta: {},
	};
}

export default t13;
