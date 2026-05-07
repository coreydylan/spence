// T8 — Locked slot resists revision.
//
// Builds a synthetic 3-meal plan where the middle meal is HARD-locked AND
// references a batch with a `resource_expired` defect (its safe_until is
// before the meal's start_at because the prep happened too early). Without
// the lock, the repair pipeline would `remake_expired_component` — clone the
// batch and rewire the meal's component_ids to the fresh clone. With the
// lock, the repair pipeline must refuse to mutate the locked meal and emit a
// `skipped_locked` action instead.
//
// This is a partial validation of the lock contract — the full revision-loop
// semantics will be exercised by T7 once the LLM-Modulo loop ships. For now
// we validate that the existing repair pass already respects locks.

import type { Scenario } from "../lib/types";
import { repairMisePlan } from "../../src/mise-graph/repair";
import { lockMeal, isMealLocked } from "../../src/mise-graph/locks";
import type { MiseWeeklyPlanDraft } from "../../src/mise-graph/planner";

const t08: Scenario = {
	id: "t08",
	name: "Locked slot is never replaced even when revision would benefit from it",
	group: "integration",
	tier: "fast",
	async run(ctx) {
		const basePlan = makeSyntheticPlan();
		// Lock the middle meal — Wed dinner, which uses the past-use-by batch.
		// Wed is deliberately positioned 5+ days after the prep so a
		// resource_expired issue fires for it.
		const lockedPlan = lockMeal(basePlan, { date: "2026-05-13", slot: "dinner" }, {
			reason: "user pinned recipe pr_abc",
			by: "user",
			scope: "hard",
			at: "2026-05-12T10:00:00.000Z",
		});

		// Sanity check.
		const wedBefore = findMeal(lockedPlan, "2026-05-13", "dinner");
		ctx.assert.ok(!!wedBefore, "Wed dinner meal exists in synthetic plan");
		ctx.assert.ok(isMealLocked(wedBefore!), "Wed dinner is hard-locked before repair");
		const wedBeforeId = wedBefore!.id;
		const wedBeforeComponentIds = wedBefore!.component_ids.slice();
		ctx.notes.push(`locked meal id=${wedBeforeId}`);
		ctx.notes.push(`locked meal component_ids before repair: ${JSON.stringify(wedBeforeComponentIds)}`);

		const result = repairMisePlan(lockedPlan);
		ctx.notes.push(`repair iterations: ${result.iterations.length}`);
		ctx.notes.push(`repair actions total: ${result.summary.actions}`);

		// Pull every action out of every iteration.
		const allActions = result.iterations.flatMap(it => it.actions);
		const skippedLocked = allActions.filter(a => a.type === "skipped_locked");
		ctx.notes.push(`skipped_locked actions: ${skippedLocked.length}`);
		for (const action of skippedLocked) {
			ctx.notes.push(`  skipped_locked: event=${action.event_id} comp=${action.component_id} type=${action.issue_type}`);
		}

		// Assertion 1: the locked meal still exists with the same id (not
		// silently replaced).
		const wedAfter = findMeal(result.repaired_plan, "2026-05-13", "dinner");
		ctx.assert.ok(!!wedAfter, "Wed dinner still present after repair");
		ctx.assert.eq(wedAfter!.id, wedBeforeId, "locked meal id is unchanged after repair");

		// Assertion 2: the locked meal's component_ids were not rewritten — even
		// though doing so would have fixed the expired-resource issue.
		ctx.assert.eq(
			JSON.stringify(wedAfter!.component_ids.slice().sort()),
			JSON.stringify(wedBeforeComponentIds.slice().sort()),
			"locked meal component_ids were not mutated by repair",
		);

		// Assertion 3: the lock metadata survived the repair pass.
		ctx.assert.ok(isMealLocked(wedAfter!), "lock metadata survives repair pipeline");

		// Assertion 4: at least one skipped_locked action references the locked
		// meal's event id.
		const matchingSkip = skippedLocked.find(a => a.event_id === wedBeforeId);
		ctx.assert.ok(!!matchingSkip, "at least one skipped_locked action references the locked meal");

		const satAfter = findMeal(result.repaired_plan, "2026-05-16", "dinner");
		const repairComponentId = satAfter?.component_ids.find(id => id.includes(":repair:"));
		ctx.assert.ok(!!repairComponentId, "unlocked expired meal is rewired to a repair component");
		const repairBatch = result.repaired_plan.component_batches.find(batch => batch.id === repairComponentId);
		const repairTask = result.repaired_plan.prep_tasks.find(task => task.state_outputs.includes(repairComponentId!));
		ctx.assert.ok(!!repairBatch && !!repairTask, "repair batch has a matching prep task");
		ctx.assert.eq(
			(repairBatch!.meta as Record<string, unknown>).desired_prep_date,
			repairTask!.scheduled_date,
			"repair batch desired_prep_date matches its actual remake task date",
		);
	},
};

function findMeal(plan: MiseWeeklyPlanDraft, date: string, slot: string) {
	for (const day of plan.meals_by_day) {
		if (day.date !== date) continue;
		for (const meal of day.meals) {
			if (meal.slot === slot) return meal;
		}
	}
	return null;
}

function makeSyntheticPlan(): MiseWeeklyPlanDraft {
	// 3 dinners across Mon/Wed/Sat. The cooked-chickpea batch is prepped on
	// 2026-05-08 with a 24h shelf-life. Both Wed (2026-05-13) and Sat
	// (2026-05-16) are well past use_by — every use will trigger
	// resource_expired at ledger compile time. The repair pipeline would
	// normally clone the batch for both meals; we lock Wed so it cannot be
	// mutated and assert the skip.
	return {
		id: "mise_plan:test_locks",
		household_id: "test",
		title: "Test locks plan",
		start_date: "2026-05-08",
		end_date: "2026-05-17",
		timezone: "UTC",
		people: 2,
		status: "draft",
		constraints: {},
		selected_ingredients: ["chickpea"],
		source_recipe_ids: [],
		meals_by_day: [
			{
				date: "2026-05-11",
				day_index: 3,
				meals: [{
					id: "meal:mon_dinner",
					date: "2026-05-11",
					slot: "dinner",
					title: "Mon dinner (control, no batch)",
					format: "skillet",
					component_ids: [],
					ingredient_names: ["egg"],
					source: "test",
					notes: [],
					people: 2,
					cuisine: ["mediterranean"],
					locked: false,
				}],
			},
			{
				date: "2026-05-13",
				day_index: 5,
				meals: [{
					id: "meal:wed_locked",
					date: "2026-05-13",
					slot: "dinner",
					title: "Wed dinner (LOCKED — uses chickpea past use_by)",
					format: "bowl",
					component_ids: ["mise_component:cooked_chickpea"],
					ingredient_names: ["cooked chickpea", "tahini"],
					source: "test",
					notes: [],
					people: 2,
					cuisine: ["mediterranean"],
					locked: false,
				}],
			},
			{
				date: "2026-05-16",
				day_index: 8,
				meals: [{
					id: "meal:sat_violator",
					date: "2026-05-16",
					slot: "dinner",
					title: "Sat dinner (uses chickpea past use_by)",
					format: "tagine",
					component_ids: ["mise_component:cooked_chickpea"],
					ingredient_names: ["cooked chickpea", "harissa"],
					source: "test",
					notes: [],
					people: 2,
					cuisine: ["north african"],
					locked: false,
				}],
			},
		],
		component_batches: [{
			id: "mise_component:cooked_chickpea",
			state_id: null,
			label: "Cooked Whole Chickpeas",
			quantity: 600,
			unit: "g",
			storage: "refrigerator",
			container: null,
			quality_window_hours: 24,
			planned_uses: [
				{ date: "2026-05-13", slot: "dinner", meal_id: "meal:wed_locked", title: "Wed locked" },
				{ date: "2026-05-16", slot: "dinner", meal_id: "meal:sat_violator", title: "Sat violator" },
			],
			station_tags: ["legume_batch_active"],
			equipment: ["instant pot"],
			active_time_min: 10,
			idle_time_min: 60,
			input_names: ["chickpea", "water", "salt"],
			meta: { source: "synthetic", desired_prep_date: "2026-05-08" },
		}],
		prep_tasks: [{
			id: "task:cook_chickpea",
			scheduled_date: "2026-05-08",
			session_order: 1,
			task_type: "cook",
			title: "Cook chickpeas",
			station_tags: ["legume_batch_active"],
			equipment: ["instant pot"],
			depends_on: [],
			state_inputs: [],
			state_outputs: ["mise_component:cooked_chickpea"],
			active_time_min: 10,
			idle_time_min: 60,
			instructions: ["Pressure-cook chickpeas with salt."],
			status: "planned",
			meta: { component_id: "mise_component:cooked_chickpea" },
		}],
		breakfasts: [],
		snack_boxes: [],
		shopping_list: [],
		shop_runs: [],
		storage_labels: [],
		meta: { generated_by: "mise_graph_planner", deterministic: true },
	};
}

export default t08;
