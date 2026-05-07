// U16 - scorePlanCoherence unit tests.
//
// This scenario keeps the API documented with synthetic plans:
//   1. A broken plan stacks duplicate/similar meals, same-day cuisine/format
//      repeats, unknown descriptors, bad leftover claims, a stale leftover edge,
//      and redundant prep batches.
//   2. A coherent control plan has declared leftovers and varied metadata, and
//      should score exactly zero.

import type { Scenario } from "../lib/types";
import { scorePlanCoherence } from "../../src/mise-graph/coherence-score";
import type {
	MiseMealSlot,
	MisePlanComponentBatch,
	MisePlanMeal,
	MisePlanTask,
	MiseWeeklyPlanDraft,
} from "../../src/mise-graph/planner";

const u16: Scenario = {
	id: "u16",
	name: "scorePlanCoherence separates broken plan coherence from a clean control",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const broken = scorePlanCoherence(makeBrokenPlan());
		ctx.notes.push(`broken score: ${broken.score}`);
		ctx.notes.push(`broken issues: ${broken.issues.map(i => i.kind).join(", ")}`);
		ctx.notes.push(`broken hard grievances: ${broken.hard_grievance_count}`);
		ctx.notes.push(`broken edge violations: ${broken.edge_violation_count}`);

		ctx.assert.gte(broken.score, 70, "broken plan scores badly");
		ctx.assert.ok(broken.duplicate_title_issues.some(i => i.kind === "duplicate_exact_meal_title"), "exact duplicate meal title is flagged");
		ctx.assert.ok(broken.duplicate_title_issues.some(i => i.kind === "duplicate_similar_meal_title"), "similar nearby meal title is flagged");
		ctx.assert.gte(broken.same_day_cuisine_issues.length, 1, "same-day cuisine repetition is flagged");
		ctx.assert.gte(broken.same_day_format_issues.length, 1, "same-day format repetition is flagged");
		ctx.assert.ok(broken.missing_descriptor_issues.some(i => i.kind === "unknown_cuisine"), "unknown cuisine is flagged");
		ctx.assert.ok(broken.missing_descriptor_issues.some(i => i.kind === "unknown_format"), "unknown format is flagged");
		ctx.assert.ok(broken.missing_descriptor_issues.some(i => i.kind === "missing_cuisine"), "missing cuisine is flagged");
		ctx.assert.ok(broken.missing_descriptor_issues.some(i => i.kind === "missing_format"), "missing format is flagged");
		ctx.assert.ok(broken.leftover_issues.some(i => i.kind === "malformed_leftover_claim"), "malformed leftover claim is flagged");
		ctx.assert.ok(broken.leftover_issues.some(i => i.kind === "reverse_time_leftover_claim"), "reverse-time leftover claim is flagged");
		ctx.assert.ok(broken.leftover_issues.some(i => i.kind === "undeclared_leftover_lunch"), "undeclared leftover lunch is flagged");
		ctx.assert.gte(broken.prep_batch_issues.length, 1, "redundant prep batches are flagged");
		ctx.assert.gte(broken.hard_grievance_count, 1, "hard critic count is included");
		ctx.assert.gte(broken.edge_violation_count, 1, "dependency edge violation count is included");
		ctx.assert.eq(
			broken.score,
			Object.values(broken.score_by_category).reduce((sum, value) => sum + value, 0),
			"score equals score_by_category total",
		);

		const coherent = scorePlanCoherence(makeCoherentPlan());
		ctx.notes.push(`coherent score: ${coherent.score}`);
		ctx.notes.push(`coherent issues: ${coherent.issues.length}`);

		ctx.assert.eq(coherent.score, 0, "coherent plan scores exactly zero");
		ctx.assert.eq(coherent.issues.length, 0, "coherent plan has no issue records");
		ctx.assert.eq(coherent.hard_grievance_count, 0, "coherent plan has no hard critic grievances");
		ctx.assert.eq(coherent.edge_violation_count, 0, "coherent plan has no dependency edge violations");
	},
};

function makeBrokenPlan(): MiseWeeklyPlanDraft {
	const mealsByDay = [
		{
			date: "2026-05-31",
			day_index: 0,
			meals: [
				makeMeal({
					id: "meal:previous_lunch",
					date: "2026-05-31",
					slot: "lunch",
					title: "Sunday Lentil Salad",
					format: "salad",
					cuisine: ["levantine"],
				}),
			],
		},
		{
			date: "2026-06-01",
			day_index: 1,
			meals: [
				makeMeal({
					id: "meal:mon_breakfast",
					date: "2026-06-01",
					slot: "breakfast",
					title: "Chickpea Grain Bowl",
					format: "bowl",
					cuisine: ["mediterranean"],
				}),
				makeMeal({
					id: "meal:mon_lunch",
					date: "2026-06-01",
					slot: "lunch",
					title: "Leftover Chickpea Bowl",
					format: "bowl",
					cuisine: ["mediterranean"],
				}),
				makeMeal({
					id: "meal:mon_snack",
					date: "2026-06-01",
					slot: "snack",
					title: "Chickpea Grain Bowl",
					format: "bowl",
					cuisine: ["mediterranean"],
				}),
				makeMeal({
					id: "meal:mon_dinner",
					date: "2026-06-01",
					slot: "dinner",
					title: "Mystery TBD Dinner",
					format: "TBD",
					cuisine: ["unknown"],
					leftovers_to: [
						"not a slot",
						"2026-05-31 lunch",
						"2026-06-06 lunch",
					],
				}),
			],
		},
		{
			date: "2026-06-06",
			day_index: 6,
			meals: [
				makeMeal({
					id: "meal:sat_lunch",
					date: "2026-06-06",
					slot: "lunch",
					title: "Mystery TBD Dinner Leftover",
					format: "sandwich",
					cuisine: ["american"],
				}),
				makeMeal({
					id: "meal:sat_dinner",
					date: "2026-06-06",
					slot: "dinner",
					title: "Plain Pantry Plate",
					format: "",
					cuisine: [],
				}),
			],
		},
	];

	const sauceA = makeBatch({
		id: "batch:green_sauce_a",
		label: "Herby Green Sauce",
		desired_prep_date: "2026-06-01",
		quality_window_hours: 96,
		planned_use: { date: "2026-06-01", slot: "dinner", meal_id: "meal:mon_dinner", title: "Mystery TBD Dinner" },
	});
	const sauceB = makeBatch({
		id: "batch:green_sauce_b",
		label: "Herb Green Sauce Batch",
		desired_prep_date: "2026-06-02",
		quality_window_hours: 96,
		planned_use: { date: "2026-06-06", slot: "lunch", meal_id: "meal:sat_lunch", title: "Mystery TBD Dinner Leftover" },
	});

	return makePlan({
		id: "mise_plan:u16_broken",
		title: "U16 broken fixture",
		start_date: "2026-05-31",
		end_date: "2026-06-06",
		meals_by_day: mealsByDay,
		component_batches: [sauceA, sauceB],
		prep_tasks: [
			makeTask("task:green_sauce_a", "2026-06-01", "batch:green_sauce_a"),
			makeTask("task:green_sauce_b", "2026-06-02", "batch:green_sauce_b"),
		],
	});
}

function makeCoherentPlan(): MiseWeeklyPlanDraft {
	return makePlan({
		id: "mise_plan:u16_coherent",
		title: "U16 coherent fixture",
		start_date: "2026-06-01",
		end_date: "2026-06-02",
		meals_by_day: [
			{
				date: "2026-06-01",
				day_index: 0,
				meals: [
					makeMeal({
						id: "meal:clean_mon_breakfast",
						date: "2026-06-01",
						slot: "breakfast",
						title: "Citrus Oat Bowl",
						format: "bowl",
						cuisine: ["california"],
					}),
					makeMeal({
						id: "meal:clean_mon_lunch",
						date: "2026-06-01",
						slot: "lunch",
						title: "Miso Rice Salad",
						format: "salad",
						cuisine: ["japanese"],
					}),
					makeMeal({
						id: "meal:clean_mon_dinner",
						date: "2026-06-01",
						slot: "dinner",
						title: "Vegetable Tacos",
						format: "taco",
						cuisine: ["mexican"],
						leftovers_to: ["2026-06-02 lunch"],
					}),
				],
			},
			{
				date: "2026-06-02",
				day_index: 1,
				meals: [
					makeMeal({
						id: "meal:clean_tue_lunch",
						date: "2026-06-02",
						slot: "lunch",
						title: "Taco Lunch",
						format: "taco",
						cuisine: ["mexican"],
					}),
					makeMeal({
						id: "meal:clean_tue_dinner",
						date: "2026-06-02",
						slot: "dinner",
						title: "Golden Lentil Soup",
						format: "soup",
						cuisine: ["indian"],
					}),
				],
			},
		],
		component_batches: [],
		prep_tasks: [],
	});
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
		source: partial.source ?? "synthetic_test",
		notes: partial.notes ?? [],
		people: partial.people ?? 2,
		cuisine: partial.cuisine ?? ["test"],
		locked: partial.locked ?? false,
		leftovers_to: partial.leftovers_to,
	};
}

function makeBatch(args: {
	id: string;
	label: string;
	desired_prep_date: string;
	quality_window_hours: number;
	planned_use: { date: string; slot: MiseMealSlot; meal_id: string; title: string };
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
		planned_uses: [args.planned_use],
		station_tags: [],
		equipment: [],
		active_time_min: 10,
		idle_time_min: 0,
		input_names: [],
		meta: { desired_prep_date: args.desired_prep_date },
	};
}

function makeTask(id: string, scheduledDate: string, output: string): MisePlanTask {
	return {
		id,
		scheduled_date: scheduledDate,
		session_order: 0,
		task_type: "component_prep",
		title: `Prep ${output}`,
		station_tags: [],
		equipment: [],
		depends_on: [],
		state_inputs: [],
		state_outputs: [output],
		active_time_min: 10,
		idle_time_min: 0,
		instructions: [],
		status: "planned",
		meta: {},
	};
}

function makePlan(args: {
	id: string;
	title: string;
	start_date: string;
	end_date: string;
	meals_by_day: MiseWeeklyPlanDraft["meals_by_day"];
	component_batches: MisePlanComponentBatch[];
	prep_tasks: MisePlanTask[];
}): MiseWeeklyPlanDraft {
	return {
		id: args.id,
		household_id: null,
		title: args.title,
		start_date: args.start_date,
		end_date: args.end_date,
		timezone: "UTC",
		people: 2,
		status: "draft",
		constraints: {},
		selected_ingredients: [],
		source_recipe_ids: [],
		meals_by_day: args.meals_by_day,
		component_batches: args.component_batches,
		prep_tasks: args.prep_tasks,
		breakfasts: [],
		snack_boxes: [],
		shopping_list: [],
		shop_runs: [],
		storage_labels: [],
		meta: { generated_by: "mise_graph_planner", deterministic: true },
	};
}

export default u16;
