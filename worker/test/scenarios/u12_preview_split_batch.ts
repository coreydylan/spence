// U12 — previewSplitBatch unit tests.
//
// Verifies that previewSplitBatch:
//   - Splits a batch with planned_uses spanning past shelf life into TWO
//     sub-batches (original + _b2) with disjoint use date ranges.
//   - Rewrites meals' component_ids to point at the appropriate sub-batch.
//   - Surfaces the original as planned_uses_changed and the new as added.
//   - Resolves a previously-firing ShelfLifeCritic grievance and yields a
//     positive waste_delta.
//   - commit() returns the post-state plan.

import type { Scenario } from "../lib/types";
import {
	previewSplitBatch,
	commit,
	clearProposalCache,
} from "../../src/mise-graph/ripple-preview";
import { runHardCritics } from "../../src/mise-graph/critics";
import type {
	MiseWeeklyPlanDraft,
	MisePlanMeal,
	MisePlanComponentBatch,
} from "../../src/mise-graph/planner";

const u12: Scenario = {
	id: "u12",
	name: "previewSplitBatch shards a too-long-shelf batch into two and resolves ShelfLifeCritic",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		clearProposalCache();
		const plan = makePlanWithLongShelfBatch();

		// Sanity: the synthetic plan has a ShelfLifeCritic violation.
		const initialGrievances = runHardCritics(plan);
		const shelfBefore = initialGrievances.filter(g => g.critic === "ShelfLifeCritic");
		ctx.notes.push(`shelf-life violations before split: ${shelfBefore.length}`);
		ctx.assert.gt(shelfBefore.length, 0, "fixture has at least one ShelfLifeCritic violation");

		// Split at day 4 — uses on/before day 3 stay, day 4+ go to the new batch.
		const splitDate = "2026-05-15";
		const preview = previewSplitBatch(plan, "mise_component:hummus", splitDate);

		ctx.notes.push(`affected_batches: ${preview.affected_batches.length}`);
		for (const b of preview.affected_batches) {
			ctx.notes.push(`  batch ${b.batch_id}: ${b.change}`);
		}

		// Two batch deltas: original (planned_uses_changed) + new sub-batch (added).
		const originalDelta = preview.affected_batches.find(b => b.batch_id === "mise_component:hummus");
		const newDelta = preview.affected_batches.find(b => b.batch_id === "mise_component:hummus_b2");
		ctx.assert.ok(!!originalDelta, "original batch surfaces in affected_batches");
		ctx.assert.eq(originalDelta!.change, "planned_uses_changed", "original change is planned_uses_changed");
		ctx.assert.ok(!!newDelta, "new sub-batch surfaces in affected_batches");
		ctx.assert.eq(newDelta!.change, "added", "new sub-batch is added");

		// Post-state: 2 batches.
		const post = preview.preview_state!.plan;
		ctx.assert.eq(post.component_batches.length, 2, "post-state has 2 batches (original + _b2)");

		// Each batch's planned_uses span ≤ 96h (shelfHours / 24 = 4 days).
		for (const b of post.component_batches) {
			const dates = b.planned_uses.map(u => u.date).sort();
			if (dates.length === 0) continue;
			const span = daysBetween(dates[0], dates[dates.length - 1]);
			ctx.notes.push(`batch ${b.id}: span=${span}d uses=${dates.length}`);
			ctx.assert.lte(span, 4, `batch ${b.id} span ${span}d fits within 96h shelf`);
		}

		// Meals on/after splitDate now point at the new sub-batch.
		for (const day of post.meals_by_day) {
			for (const meal of day.meals) {
				if (meal.component_ids.length === 0) continue;
				if (meal.date >= splitDate) {
					ctx.assert.contains(meal.component_ids, "mise_component:hummus_b2",
						`meal ${meal.id} on ${meal.date} points at new sub-batch`);
				} else {
					ctx.assert.contains(meal.component_ids, "mise_component:hummus",
						`meal ${meal.id} on ${meal.date} still points at original`);
				}
			}
		}

		// New prep_task added for the new sub-batch.
		const newPrepDelta = preview.affected_prep_tasks.find(t => t.change === "added");
		ctx.assert.ok(!!newPrepDelta, "a new prep task is surfaced for the new sub-batch");

		// Grievances: the previously-firing ShelfLifeCritic is resolved.
		const resolved = preview.resolved_grievances.filter(g => g.critic === "ShelfLifeCritic");
		ctx.notes.push(`resolved shelf-life grievances: ${resolved.length}`);
		ctx.assert.gt(resolved.length, 0, "split resolves at least one ShelfLifeCritic grievance");

		// waste_delta is non-negative (split fixes waste; sometimes new orphans
		// can occur but the net should be 0+).
		ctx.notes.push(`waste_delta=${preview.scores.waste_delta} effort_delta=${preview.scores.effort_delta}`);
		ctx.assert.gte(preview.scores.waste_delta, 0, "split resolves shelf-life waste (waste_delta ≥ 0)");

		// commit returns the post-state plan.
		const committed = commit(plan, preview.proposal_id);
		ctx.assert.eq(committed.component_batches.length, 2, "commit returns post-state with 2 batches");

		// Caller's input plan is unchanged (deep-clone discipline).
		ctx.assert.eq(plan.component_batches.length, 1, "input plan unchanged (deep-clone discipline)");

		// Edge case: split that doesn't move any uses → no-op.
		clearProposalCache();
		const noOp = previewSplitBatch(plan, "mise_component:hummus", "2026-06-01");
		ctx.assert.gt(noOp.warnings.length, 0, "no-op split produces a warning");
		ctx.assert.eq(noOp.affected_batches.length, 0, "no-op split has empty affected_batches");

		// Edge case: missing batch.
		clearProposalCache();
		const missing = previewSplitBatch(plan, "no_such_batch", splitDate);
		ctx.assert.gt(missing.warnings.length, 0, "missing batch yields a warning");
		ctx.assert.contains(missing.warnings.join(" "), "not found", "warning mentions 'not found'");
	},
};

// ---------------------------------------------------------------------------
// Fixture: a hummus batch with 8 uses across a 14-day window. Shelf is 96h
// (4 days). The planner pre-rebatch would call this an over-extended single
// batch; our split should chop it in half.
// ---------------------------------------------------------------------------

function makePlanWithLongShelfBatch(): MiseWeeklyPlanDraft {
	const useDates = [
		"2026-05-11", "2026-05-12", "2026-05-13", "2026-05-14",  // group 1
		"2026-05-15", "2026-05-16", "2026-05-17", "2026-05-18",  // group 2
	];
	const meals: MisePlanMeal[] = useDates.map((d, i) => makeMeal({
		id: `meal:lunch_${i}`,
		date: d,
		slot: "lunch",
		title: `Hummus Lunch ${i}`,
		component_ids: ["mise_component:hummus"],
	}));
	const meals_by_day = useDates.map((d, i) => ({
		date: d,
		day_index: i,
		meals: [meals[i]],
	}));

	const batch: MisePlanComponentBatch = {
		id: "mise_component:hummus",
		state_id: null,
		label: "Hummus",
		quantity: 800,
		unit: "g",
		storage: "refrigerator",
		container: null,
		quality_window_hours: 96,
		planned_uses: useDates.map((d, i) => ({
			date: d,
			slot: "lunch",
			meal_id: `meal:lunch_${i}`,
			title: `Hummus Lunch ${i}`,
		})),
		station_tags: ["sauce_active"],
		equipment: ["food processor"],
		active_time_min: 12,
		idle_time_min: 0,
		input_names: ["chickpea", "tahini", "lemon juice", "garlic"],
		meta: { source: "synthetic_test" },
	};

	return {
		id: "mise_plan:u12",
		household_id: "test",
		title: "U12 fixture",
		start_date: "2026-05-11",
		end_date: "2026-05-18",
		timezone: "UTC",
		people: 2,
		status: "draft",
		constraints: {},
		selected_ingredients: [],
		source_recipe_ids: [],
		meals_by_day,
		component_batches: [batch],
		prep_tasks: [],
		breakfasts: [],
		snack_boxes: [],
		shopping_list: [],
		shop_runs: [],
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

function daysBetween(a: string, b: string): number {
	const da = new Date(a + "T00:00:00Z").getTime();
	const db = new Date(b + "T00:00:00Z").getTime();
	return Math.round((db - da) / 86400000);
}

export default u12;
