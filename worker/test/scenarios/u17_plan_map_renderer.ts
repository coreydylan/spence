// U17 - plan-map renderer unit tests.
//
// Builds a compact synthetic plan with intentionally broken time physics:
//   - a 48h idle dough used after only 24h,
//   - a stale leftover claim spanning 5 days,
//   - a short shelf-life herb yogurt batch used after 48h,
// plus one boundary-critical freshness edge. The assertions focus on the
// renderer contract: stable agent-readable sections in compact mode, and JSON
// lookup blocks in full mode.

import type { Scenario } from "../lib/types";
import { renderPlanMap } from "../../src/mise-graph/plan-map-renderer";
import type {
	MisePlanComponentBatch,
	MisePlanMeal,
	MisePlanTask,
	MiseWeeklyPlanDraft,
} from "../../src/mise-graph/planner";

const u17: Scenario = {
	id: "u17",
	name: "renderPlanMap exposes compact calendar, edges, grievances, shopping, and full JSON",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const plan = makeBrokenPlan();
		const compact = renderPlanMap(plan);

		ctx.assert.eq(renderPlanMap(plan), compact, "compact render is deterministic");
		ctx.assert.contains(compact, "# Plan Map", "renders plan-map title");
		ctx.assert.contains(compact, "## Window / Status", "renders window/status summary");
		ctx.assert.contains(compact, "## Calendar Grid", "renders calendar grid section");
		ctx.assert.contains(compact, "| Day | Shop | Prep | Breakfast | Lunch | Snack | Dinner |", "calendar grid has expected columns");
		ctx.assert.contains(compact, "2026-05-12 Tue", "calendar includes Tuesday row");
		ctx.assert.contains(compact, "Dough Too Early Flatbread", "calendar includes broken dough meal title");
		ctx.assert.contains(compact, "mise_component:48h_idle_dough", "calendar and batches expose dough component id");
		ctx.assert.contains(compact, "Snack Box", "calendar includes snack cell content");

		ctx.assert.contains(compact, "## Component Batches", "renders component batch section");
		ctx.assert.contains(compact, "48h Idle Dough", "component section includes dough label");
		ctx.assert.contains(compact, "Short Shelf Herb Yogurt", "component section includes shelf-life batch label");
		ctx.assert.contains(compact, "planned uses:", "component section exposes planned uses");

		ctx.assert.contains(compact, "## Dependency Edges", "renders dependency edge section");
		ctx.assert.contains(compact, "### Violated Edges", "renders violated edge subsection");
		ctx.assert.contains(compact, "VIOLATED", "violated edges use explicit violation language");
		ctx.assert.contains(compact, "rule=min_lead_time:48h", "48h idle dough violation is visible");
		ctx.assert.contains(compact, "rule=leftover_window:72h", "stale leftover edge is visible");
		ctx.assert.contains(compact, "### Critical Edges", "renders critical edge subsection");
		ctx.assert.contains(compact, "CRITICAL", "critical edge language is visible");
		ctx.assert.contains(compact, "mise_component:critical_relish", "critical component id is visible");

		ctx.assert.contains(compact, "## Shopping", "renders shopping section");
		ctx.assert.contains(compact, "mise_shop_run:mon", "shopping run id is visible");
		ctx.assert.contains(compact, "flour", "shopping list item is visible");

		ctx.assert.contains(compact, "## Grievances", "renders grievances section");
		ctx.assert.contains(compact, "### Hard", "groups grievances by hard severity");
		ctx.assert.contains(compact, "ShelfLifeCritic", "shelf-life grievance is visible");
		ctx.assert.contains(compact, "EdgeViolationCritic", "edge violation grievance is visible");
		ctx.assert.contains(compact, "cascade proposals:", "grievances summarize cascade proposals");
		ctx.assert.contains(compact, "[split_batch", "cascade proposal kind is visible");
		ctx.assert.contains(compact, "Short Shelf Herb Yogurt", "grievance text names the bad shelf-life batch");
		ctx.assert.contains(compact, "## Coherence Score", "renders coherence score section");
		ctx.assert.contains(compact, "dependency_edge_violations", "coherence issues include dependency edge summary");
		ctx.assert.contains(compact, "missing_cuisine", "coherence issues expose missing cuisine metadata");

		const full = renderPlanMap(plan, { mode: "full" });
		const jsonFenceCount = (full.match(/```json/g) || []).length;
		ctx.assert.gte(jsonFenceCount, 5, "full mode appends multiple JSON fences");
		ctx.assert.contains(full, "## Full Data", "full mode appends full-data section");
		ctx.assert.contains(full, "### plan", "full mode includes plan JSON block");
		ctx.assert.contains(full, "### dependency_edges", "full mode includes dependency edge JSON block");
		ctx.assert.contains(full, "### grievances", "full mode includes grievance JSON block");
		ctx.assert.contains(full, "### coherence", "full mode includes coherence JSON block");
		ctx.assert.contains(full, "\"id\": \"mise_plan:u17\"", "plan JSON includes precise plan id");
		ctx.assert.contains(full, "\"status\": \"violated\"", "edge JSON includes violated status");
		ctx.assert.contains(full, "\"critic\": \"ShelfLifeCritic\"", "grievance JSON includes critic id");
		ctx.assert.contains(full, "\"score_by_category\"", "coherence JSON includes score category details");
	},
};

function makeBrokenPlan(): MiseWeeklyPlanDraft {
	const monDinner = makeMeal({
		id: "meal:mon_dinner",
		date: "2026-05-11",
		slot: "dinner",
		title: "Roasted Tomato Pasta",
		leftovers_to: ["2026-05-16 lunch"],
		raw_ingredients: [{ name: "tomato", qty: 4, unit: "each", grams: 480, category: "produce" }],
	});
	const tueLunch = makeMeal({
		id: "meal:tue_lunch_dough",
		date: "2026-05-12",
		slot: "lunch",
		title: "Dough Too Early Flatbread",
		component_ids: ["mise_component:48h_idle_dough"],
		raw_ingredients: [{ name: "olive oil", qty: 2, unit: "tbsp", grams: 28, category: "pantry" }],
	});
	const wedDinner = makeMeal({
		id: "meal:wed_dinner_yogurt",
		date: "2026-05-13",
		slot: "dinner",
		title: "Herb Yogurt Plate",
		component_ids: ["mise_component:herb_yogurt"],
	});
	const thuDinner = makeMeal({
		id: "meal:thu_dinner_relish",
		date: "2026-05-14",
		slot: "dinner",
		title: "Critical Relish Bowl",
		component_ids: ["mise_component:critical_relish"],
	});
	const satLunch = makeMeal({
		id: "meal:sat_lunch_leftovers",
		date: "2026-05-16",
		slot: "lunch",
		title: "Stale Pasta Leftover Lunch",
	});
	const monBreakfast = makeMeal({
		id: "meal:mon_breakfast",
		date: "2026-05-11",
		slot: "breakfast",
		title: "Yogurt Breakfast Bowl",
	});

	const batches: MisePlanComponentBatch[] = [
		makeBatch({
			id: "mise_component:48h_idle_dough",
			label: "48h Idle Dough",
			quantity: 600,
			unit: "g",
			quality_window_hours: 96,
			idle_time_min: 2880,
			input_names: ["flour", "yeast", "water"],
			planned_uses: [{ date: "2026-05-12", slot: "lunch", meal_id: tueLunch.id, title: tueLunch.title }],
			meta: { desired_prep_date: "2026-05-11" },
		}),
		makeBatch({
			id: "mise_component:herb_yogurt",
			label: "Short Shelf Herb Yogurt",
			quantity: 300,
			unit: "g",
			quality_window_hours: 24,
			input_names: ["yogurt", "fresh herbs"],
			planned_uses: [{ date: "2026-05-13", slot: "dinner", meal_id: wedDinner.id, title: wedDinner.title }],
			meta: { desired_prep_date: "2026-05-11" },
		}),
		makeBatch({
			id: "mise_component:critical_relish",
			label: "Critical Cucumber Relish",
			quantity: 250,
			unit: "g",
			quality_window_hours: 48,
			input_names: ["cucumber", "vinegar"],
			planned_uses: [{ date: "2026-05-14", slot: "dinner", meal_id: thuDinner.id, title: thuDinner.title }],
			meta: { desired_prep_date: "2026-05-12" },
		}),
	];

	const prepTasks: MisePlanTask[] = [
		makeTask({
			id: "task:mon:dough",
			scheduled_date: "2026-05-11",
			session_order: 1,
			title: "Mix 48h idle dough",
			state_inputs: ["flour", "yeast", "water"],
			state_outputs: ["mise_component:48h_idle_dough"],
			idle_time_min: 2880,
		}),
		makeTask({
			id: "task:mon:yogurt",
			scheduled_date: "2026-05-11",
			session_order: 2,
			title: "Blend short shelf herb yogurt",
			state_inputs: ["yogurt", "fresh herbs"],
			state_outputs: ["mise_component:herb_yogurt"],
		}),
		makeTask({
			id: "task:tue:relish",
			scheduled_date: "2026-05-12",
			session_order: 1,
			title: "Make boundary cucumber relish",
			state_inputs: ["cucumber", "vinegar"],
			state_outputs: ["mise_component:critical_relish"],
		}),
	];

	return {
		id: "mise_plan:u17",
		household_id: "test",
		title: "U17 Broken Plan",
		start_date: "2026-05-11",
		end_date: "2026-05-16",
		timezone: "UTC",
		people: 2,
		status: "draft",
		constraints: { dietary: ["vegetarian"] },
		selected_ingredients: ["flour", "yogurt", "cucumber"],
		source_recipe_ids: [],
		meals_by_day: [
			{ date: "2026-05-11", day_index: 0, meals: [monDinner] },
			{ date: "2026-05-12", day_index: 1, meals: [tueLunch] },
			{ date: "2026-05-13", day_index: 2, meals: [wedDinner] },
			{ date: "2026-05-14", day_index: 3, meals: [thuDinner] },
			{ date: "2026-05-15", day_index: 4, meals: [] },
			{ date: "2026-05-16", day_index: 5, meals: [satLunch] },
		],
		component_batches: batches,
		prep_tasks: prepTasks,
		breakfasts: [monBreakfast],
		snack_boxes: [
			{
				id: "snack:tue_box",
				date: "2026-05-12",
				title: "Snack Box",
				items: ["apple slices", "nuts"],
				component_ids: [],
				people: 2,
				locked: false,
			},
		],
		shopping_list: [
			{
				category: "dairy",
				items: [{ name: "yogurt", quantity: 1, unit: "tub", source: ["mise_component:herb_yogurt"], grams_total: 300 }],
			},
			{
				category: "pantry",
				items: [
					{ name: "flour", quantity: 1, unit: "bag", source: ["mise_component:48h_idle_dough"], grams_total: 600 },
					{ name: "vinegar", quantity: 1, unit: "bottle", source: ["mise_component:critical_relish"], grams_total: 60 },
				],
			},
			{
				category: "produce",
				items: [
					{ name: "cucumber", quantity: 2, unit: "each", source: ["mise_component:critical_relish"], grams_total: 250 },
					{ name: "fresh herbs", quantity: 1, unit: "bunch", source: ["mise_component:herb_yogurt"], grams_total: 40 },
				],
			},
		],
		shop_runs: [
			{
				id: "mise_shop_run:mon",
				date: "2026-05-11",
				label: "Monday full shop",
				categories: ["dairy", "pantry", "produce"],
				item_count: 5,
			},
		],
		storage_labels: [],
		meta: { generated_by: "mise_graph_planner", deterministic: true },
	};
}

function makeMeal(partial: Partial<MisePlanMeal> & {
	id: string;
	date: string;
	slot: MisePlanMeal["slot"];
	title: string;
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

function makeBatch(partial: Partial<MisePlanComponentBatch> & {
	id: string;
	label: string;
	planned_uses: MisePlanComponentBatch["planned_uses"];
}): MisePlanComponentBatch {
	return {
		id: partial.id,
		state_id: partial.state_id ?? null,
		label: partial.label,
		quantity: partial.quantity ?? null,
		unit: partial.unit ?? null,
		storage: partial.storage ?? "refrigerator",
		container: partial.container ?? null,
		quality_window_hours: partial.quality_window_hours ?? null,
		planned_uses: partial.planned_uses,
		station_tags: partial.station_tags ?? [],
		equipment: partial.equipment ?? [],
		active_time_min: partial.active_time_min ?? 15,
		idle_time_min: partial.idle_time_min ?? 0,
		input_names: partial.input_names ?? [],
		meta: partial.meta ?? { source: "synthetic_test" },
	};
}

function makeTask(partial: Partial<MisePlanTask> & {
	id: string;
	scheduled_date: string;
	session_order: number;
	title: string;
	state_outputs: string[];
}): MisePlanTask {
	return {
		id: partial.id,
		scheduled_date: partial.scheduled_date,
		session_order: partial.session_order,
		task_type: partial.task_type ?? "prep_task",
		title: partial.title,
		station_tags: partial.station_tags ?? [],
		equipment: partial.equipment ?? [],
		depends_on: partial.depends_on ?? [],
		state_inputs: partial.state_inputs ?? [],
		state_outputs: partial.state_outputs,
		active_time_min: partial.active_time_min ?? 15,
		idle_time_min: partial.idle_time_min ?? 0,
		instructions: partial.instructions ?? [],
		status: "planned",
		meta: partial.meta ?? { source: "synthetic_test" },
	};
}

export default u17;
