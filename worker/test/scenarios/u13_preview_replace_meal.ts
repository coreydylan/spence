// U13 — previewReplaceMeal unit tests.
//
// Verifies four code paths:
//   1. replace_meal with a full new_meal swaps content while preserving id.
//   2. replace_meal with only must_consume hints builds a placeholder meal
//      whose raw_ingredients reflect the hints.
//   3. replace_meal with neither new_meal nor hints returns a no-op + warning.
//   4. replace_meal targeting a hard-locked slot returns blocked + warning.

import type { Scenario } from "../lib/types";
import {
	previewReplaceMeal,
	commit,
	clearProposalCache,
} from "../../src/mise-graph/ripple-preview";
import type {
	MiseWeeklyPlanDraft,
	MisePlanMeal,
} from "../../src/mise-graph/planner";

const u13: Scenario = {
	id: "u13",
	name: "previewReplaceMeal supports full new_meal, must_consume hints, and lock/no-op fast paths",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// --- Path 1: explicit new_meal swap, id preserved -----------------------
		clearProposalCache();
		let plan = makePlan({ locked: false });
		const slot = { date: "2026-05-12", slot: "dinner" };
		const fullSwap = previewReplaceMeal(plan, slot, {
			title: "Lentil Mushroom Bowl",
			format: "bowl",
			cuisine: ["mediterranean"],
			raw_ingredients: [
				{ name: "lentil", qty: 200, unit: "g", grams: 200 },
				{ name: "mushroom", qty: 150, unit: "g", grams: 150 },
			],
			method_summary: "simmer lentils, sauté mushrooms, combine",
		});

		ctx.notes.push(`fullSwap warnings: ${fullSwap.warnings.length}`);
		ctx.assert.eq(fullSwap.warnings.length, 0, "explicit new_meal produces no warnings");
		ctx.assert.gt(fullSwap.affected_meals.length, 0, "explicit new_meal surfaces affected_meals");

		const post = fullSwap.preview_state!.plan;
		const replacedMeal = post.meals_by_day
			.find(d => d.date === slot.date)!.meals
			.find(m => m.slot === slot.slot)!;
		ctx.assert.eq(replacedMeal.id, "meal:tue_dinner_violation", "meal id is preserved");
		ctx.assert.eq(replacedMeal.title, "Lentil Mushroom Bowl", "meal title is updated");
		ctx.assert.eq(replacedMeal.format, "bowl", "meal format is updated");
		ctx.assert.contains(replacedMeal.cuisine, "mediterranean", "meal cuisine is updated");
		const newRawNames = (replacedMeal.raw_ingredients || []).map(r => r.name);
		ctx.assert.contains(newRawNames, "lentil", "lentil is in raw_ingredients");
		ctx.assert.contains(newRawNames, "mushroom", "mushroom is in raw_ingredients");

		// commit() returns the post-state.
		const committed = commit(plan, fullSwap.proposal_id);
		const committedMeal = committed.meals_by_day
			.find(d => d.date === slot.date)!.meals
			.find(m => m.slot === slot.slot)!;
		ctx.assert.eq(committedMeal.title, "Lentil Mushroom Bowl", "commit returns the new title");

		// --- Path 2: hints-only placeholder -------------------------------------
		clearProposalCache();
		plan = makePlan({ locked: false });
		const hintsOnly = previewReplaceMeal(plan, slot, undefined, {
			must_consume: ["leftover chickpea", "tahini"],
		});
		ctx.notes.push(`hintsOnly warnings: ${hintsOnly.warnings.length}`);
		ctx.assert.eq(hintsOnly.warnings.length, 0, "hints-only placeholder produces no warnings");
		const hintsPost = hintsOnly.preview_state!.plan;
		const placeholder = hintsPost.meals_by_day
			.find(d => d.date === slot.date)!.meals
			.find(m => m.slot === slot.slot)!;
		ctx.assert.matches(placeholder.title, /TBD/i, "placeholder title contains TBD");
		ctx.assert.matches(placeholder.title, /must consume/i, "placeholder title mentions 'must consume'");
		const hintsRawNames = (placeholder.raw_ingredients || []).map(r => r.name);
		ctx.assert.contains(hintsRawNames, "leftover chickpea", "placeholder includes hint ingredient #1");
		ctx.assert.contains(hintsRawNames, "tahini", "placeholder includes hint ingredient #2");

		// --- Path 3: no new_meal AND no hints → no-op + warning -----------------
		clearProposalCache();
		plan = makePlan({ locked: false });
		const empty = previewReplaceMeal(plan, slot, undefined, undefined);
		ctx.assert.gt(empty.warnings.length, 0, "no new_meal/no hints produces a warning");
		ctx.assert.contains(empty.warnings.join(" "), "must_consume", "warning mentions must_consume requirement");
		ctx.assert.eq(empty.affected_meals.length, 0, "no-op produces no affected_meals");

		// --- Path 4: hard-locked target → blocked + warning ---------------------
		clearProposalCache();
		plan = makePlan({ locked: true });
		const blocked = previewReplaceMeal(plan, slot, {
			title: "Should Be Blocked",
			format: "bowl",
		});
		ctx.assert.gt(blocked.warnings.length, 0, "locked slot produces a warning");
		ctx.assert.matches(blocked.warnings.join(" "), /lock/i, "warning mentions lock");
		ctx.assert.eq(blocked.affected_meals.length, 0, "blocked attempt makes no changes");

		// --- Path 5: missing slot ------------------------------------------------
		clearProposalCache();
		plan = makePlan({ locked: false });
		const missing = previewReplaceMeal(plan, { date: "2026-12-31", slot: "dinner" }, {
			title: "Nope",
		});
		ctx.assert.gt(missing.warnings.length, 0, "missing slot produces a warning");
		ctx.assert.contains(missing.warnings.join(" "), "no meal", "warning mentions no meal at slot");
	},
};

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function makePlan(opts: { locked: boolean }): MiseWeeklyPlanDraft {
	const tueDinner: MisePlanMeal = makeMeal({
		id: "meal:tue_dinner_violation",
		date: "2026-05-12",
		slot: "dinner",
		title: "Pan-Seared Salmon with Greens",
		format: "skillet",
		ingredient_names: ["salmon", "kale"],
		raw_ingredients: [
			{ name: "salmon", qty: 200, unit: "g", grams: 200, category: null },
			{ name: "kale", qty: 150, unit: "g", grams: 150, category: null },
		],
		meta: opts.locked ? { lock: { locked: true, lock_reason: "user pin", locked_at: "2026-05-01T00:00:00Z" } } : undefined,
	});

	return {
		id: "mise_plan:u13",
		household_id: "test",
		title: "U13 fixture",
		start_date: "2026-05-12",
		end_date: "2026-05-12",
		timezone: "UTC",
		people: 2,
		status: "draft",
		constraints: {},
		selected_ingredients: [],
		source_recipe_ids: [],
		meals_by_day: [
			{ date: "2026-05-12", day_index: 0, meals: [tueDinner] },
		],
		component_batches: [],
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
		meta: partial.meta,
	};
}

export default u13;
