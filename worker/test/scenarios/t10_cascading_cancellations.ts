// T10 — Cascade of cancellations doesn't corrupt state.
//
// Builds a 7-day plan where each dinner feeds the next day's lunch via a
// leftover claim, with a per-dinner batch that only feeds that one dinner
// (so canceling the dinner orphans its batch). Sequentially preview+commit
// cancel of Mon, Tue, and Wed dinners and assert world-model consistency:
//   - No batch's planned_uses references a meal that no longer exists.
//   - Batches with zero remaining uses are surfaced as orphaned in the
//     final preview (not silently retained as live).
//   - Critics on un-touched slots (Thu, Fri, Sat, Sun dinners) produce the
//     same set of grievance fingerprints pre-cascade and post-cascade.

import type { Scenario } from "../lib/types";
import {
	previewCancelMeal,
	commit,
	clearProposalCache,
} from "../../src/mise-graph/ripple-preview";
import { runHardCritics, type Grievance } from "../../src/mise-graph/critics";
import type {
	MiseWeeklyPlanDraft,
	MisePlanMeal,
	MisePlanComponentBatch,
} from "../../src/mise-graph/planner";

const t10: Scenario = {
	id: "t10",
	name: "Three sequential meal cancellations preserve world-model consistency",
	group: "adversarial",
	tier: "fast",
	async run(ctx) {
		clearProposalCache();
		const initial = build7DayChain();

		// Capture pre-cascade grievance fingerprints for the un-touched dinners.
		const preFingerprints = critFingerprintsFor(initial, ["thu_dinner", "fri_dinner", "sat_dinner", "sun_dinner"]);

		// 1) cancel mon_dinner
		const p1 = previewCancelMeal(initial, { date: "2026-05-11", slot: "dinner" });
		ctx.assert.eq(p1.reversible, true, "step1 preview is reversible");
		const after1 = commit(initial, p1.proposal_id);

		// 2) cancel tue_dinner on top of step1
		const p2 = previewCancelMeal(after1, { date: "2026-05-12", slot: "dinner" });
		ctx.assert.eq(p2.reversible, true, "step2 preview is reversible");
		const after2 = commit(after1, p2.proposal_id);

		// 3) cancel wed_dinner on top of step2
		const p3 = previewCancelMeal(after2, { date: "2026-05-13", slot: "dinner" });
		ctx.assert.eq(p3.reversible, true, "step3 preview is reversible");
		const after3 = commit(after2, p3.proposal_id);

		// (a) No phantom resources: every planned_use references a surviving meal.
		const survivingIds = collectMealIds(after3);
		for (const batch of after3.component_batches) {
			for (const use of batch.planned_uses) {
				ctx.assert.ok(
					survivingIds.has(use.meal_id),
					`batch ${batch.id} use references surviving meal_id=${use.meal_id}`,
				);
			}
		}

		// (b) The dinner-bound batches that were only used by the canceled dinners
		// are now orphaned in the final state (planned_uses empty).
		const monBatch = after3.component_batches.find(b => b.id === "mise_component:mon_sauce");
		const tueBatch = after3.component_batches.find(b => b.id === "mise_component:tue_sauce");
		const wedBatch = after3.component_batches.find(b => b.id === "mise_component:wed_sauce");
		ctx.notes.push(`mon_sauce uses: ${monBatch?.planned_uses.length}`);
		ctx.notes.push(`tue_sauce uses: ${tueBatch?.planned_uses.length}`);
		ctx.notes.push(`wed_sauce uses: ${wedBatch?.planned_uses.length}`);
		ctx.assert.eq(monBatch?.planned_uses.length, 0, "mon_sauce orphaned (no consumers)");
		ctx.assert.eq(tueBatch?.planned_uses.length, 0, "tue_sauce orphaned");
		ctx.assert.eq(wedBatch?.planned_uses.length, 0, "wed_sauce orphaned");

		// (c) No batch quantity went negative (defensive).
		for (const batch of after3.component_batches) {
			ctx.assert.ok(
				batch.quantity === null || batch.quantity >= 0,
				`batch ${batch.id} quantity is non-negative`,
			);
		}

		// (d) Critics on un-touched slots produce identical grievance
		// fingerprints pre vs post cascade.
		const postFingerprints = critFingerprintsFor(after3, ["thu_dinner", "fri_dinner", "sat_dinner", "sun_dinner"]);
		ctx.assert.eq(
			postFingerprints,
			preFingerprints,
			"critics on un-touched slots have identical grievance fingerprints",
		);
	},
};

// ---------------------------------------------------------------------------
// fingerprinting helpers
// ---------------------------------------------------------------------------

function critFingerprintsFor(plan: MiseWeeklyPlanDraft, mealIds: string[]): string {
	const all = runHardCritics(plan);
	const ids = new Set(mealIds.map(id => `meal:${id}`));
	const slotIndex = new Map<string, string>();
	for (const m of collectAllMeals(plan)) {
		if (ids.has(m.id)) slotIndex.set(`${m.date}::${m.slot}`, m.id);
	}
	const matched = all.filter((g: Grievance) => {
		if (!g.slot_ref) return false;
		return slotIndex.has(`${g.slot_ref.date}::${g.slot_ref.slot}`);
	});
	return matched
		.map(g => `${g.critic}|${g.slot_ref?.date}::${g.slot_ref?.slot}|${(g.message || "").slice(0, 60)}`)
		.sort()
		.join("\n");
}

function collectAllMeals(plan: MiseWeeklyPlanDraft): MisePlanMeal[] {
	const out: MisePlanMeal[] = [];
	for (const day of plan.meals_by_day || []) for (const m of day.meals) out.push(m);
	for (const b of plan.breakfasts || []) out.push(b);
	return out;
}

function collectMealIds(plan: MiseWeeklyPlanDraft): Set<string> {
	const ids = new Set<string>();
	for (const m of collectAllMeals(plan)) ids.add(m.id);
	for (const s of plan.snack_boxes || []) ids.add(s.id);
	return ids;
}

// ---------------------------------------------------------------------------
// fixture builder
// ---------------------------------------------------------------------------

function build7DayChain(): MiseWeeklyPlanDraft {
	const dates = ["2026-05-11", "2026-05-12", "2026-05-13", "2026-05-14", "2026-05-15", "2026-05-16", "2026-05-17"];
	const labels = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

	const meals_by_day = dates.map((date, idx) => {
		const meals: MisePlanMeal[] = [];
		// Lunch on every day except Mon (the chain starts at Mon dinner).
		if (idx > 0) {
			meals.push(makeMeal({
				id: `meal:${labels[idx]}_lunch`,
				date,
				slot: "lunch",
				title: `${labels[idx]} lunch (leftover from prior dinner)`,
				format: "bowl",
				raw_ingredients: [{ name: "lettuce", qty: 100, unit: "g", grams: 100, category: null }],
			}));
		}
		// Dinner every day, with leftover_to next day's lunch (except Sun).
		const leftoverNext = idx < 6 ? [`${dates[idx + 1]} lunch`] : undefined;
		meals.push(makeMeal({
			id: `meal:${labels[idx]}_dinner`,
			date,
			slot: "dinner",
			title: `${labels[idx]} dinner`,
			format: "bowl",
			component_ids: [`mise_component:${labels[idx]}_sauce`],
			raw_ingredients: [
				{ name: `${labels[idx]} protein`, qty: 200, unit: "g", grams: 200, category: null },
				{ name: `${labels[idx]} starch`, qty: 250, unit: "g", grams: 250, category: null },
			],
			leftovers_to: leftoverNext,
		}));
		return { date, day_index: idx, meals };
	});

	// Per-dinner sauce batches; each has exactly one consumer (its dinner).
	const component_batches: MisePlanComponentBatch[] = labels.map((lbl, idx) => ({
		id: `mise_component:${lbl}_sauce`,
		state_id: null,
		label: `${lbl} sauce`,
		quantity: 100,
		unit: "g",
		storage: "refrigerator",
		container: "jar",
		quality_window_hours: 96,
		planned_uses: [{ date: dates[idx], slot: "dinner", meal_id: `meal:${lbl}_dinner`, title: `${lbl} dinner` }],
		station_tags: ["sauce_active"],
		equipment: ["bowl"],
		active_time_min: 5,
		idle_time_min: 0,
		input_names: ["oil", "vinegar"],
		meta: { source: "synthetic_test" },
	}));

	return {
		id: "mise_plan:t10_fixture",
		household_id: "test",
		title: "T10 fixture (7-day chain)",
		start_date: dates[0],
		end_date: dates[6],
		timezone: "UTC",
		people: 2,
		status: "draft",
		constraints: {},
		selected_ingredients: [],
		source_recipe_ids: [],
		meals_by_day,
		component_batches,
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

export default t10;
