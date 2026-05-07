// U7 — Targeted unit tests for the RipplePreview surface.
//
//   - previewCancelMeal on a non-existent slot returns a no-op preview with
//     warnings and empty deltas.
//   - previewMoveMeal from slot A → empty slot B shows A removed (moved) and
//     B with the same meal_id at the new slot.
//   - previewSwapIngredient rebuilds the shopping list and surfaces the swap.
//   - commit with an unknown proposal_id throws.

import type { Scenario } from "../lib/types";
import {
	previewCancelMeal,
	previewMoveMeal,
	previewSwapIngredient,
	commit,
	clearProposalCache,
} from "../../src/mise-graph/ripple-preview";
import type {
	MiseWeeklyPlanDraft,
	MisePlanMeal,
} from "../../src/mise-graph/planner";

const u07: Scenario = {
	id: "u07",
	name: "RipplePreview unit: missing-slot, move, swap_ingredient, unknown commit",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		clearProposalCache();
		const plan = makeMinimalPlan();

		// (1) cancel on a slot that doesn't exist → warnings + empty deltas
		const noOp = previewCancelMeal(plan, { date: "2026-05-13", slot: "snack" });
		ctx.assert.gt(noOp.warnings.length, 0, "non-existent slot produces warnings");
		ctx.assert.eq(noOp.affected_meals.length, 0, "no meals affected on no-op");
		ctx.assert.eq(noOp.affected_batches.length, 0, "no batches affected on no-op");
		ctx.assert.eq(noOp.affected_shopping.removed.length, 0, "no shopping removals on no-op");
		ctx.assert.eq(noOp.affected_shopping.added.length, 0, "no shopping additions on no-op");
		// commit on a no-op preview is allowed: returns plan unchanged.
		const noOpCommitted = commit(plan, noOp.proposal_id);
		ctx.assert.ok(noOpCommitted.meals_by_day.length === plan.meals_by_day.length, "no-op commit preserves day count");

		// (2) move dinner from Wed → Sun (Sun was empty) → moved delta surfaces
		const movePreview = previewMoveMeal(
			plan,
			{ date: "2026-05-13", slot: "dinner" },
			{ date: "2026-05-17", slot: "dinner" },
			"replace",
		);
		const moved = movePreview.affected_meals.find(d => d.meal_id === "meal:wed_dinner" && d.change === "moved");
		ctx.assert.ok(!!moved, "Wed dinner appears as moved");
		ctx.assert.eq(moved!.after?.date, "2026-05-17", "moved meal's new date is Sun");
		ctx.assert.eq(moved!.after?.slot, "dinner", "moved meal's slot stays dinner");
		ctx.assert.eq(movePreview.reversible, true, "move is reversible");

		// commit moves the meal in the resulting plan.
		const movedPlan = commit(plan, movePreview.proposal_id);
		const wedAfter = movedPlan.meals_by_day.find(d => d.date === "2026-05-13");
		const sunAfter = movedPlan.meals_by_day.find(d => d.date === "2026-05-17");
		ctx.assert.ok(!wedAfter?.meals.some(m => m.id === "meal:wed_dinner"), "Wed dinner no longer at Wed in committed plan");
		ctx.assert.ok(!!sunAfter?.meals.some(m => m.id === "meal:wed_dinner" && m.slot === "dinner"), "Wed dinner now at Sun in committed plan");

		// (3) swap_ingredient surfaces a shopping change.
		const swapPreview = previewSwapIngredient(
			plan,
			{ date: "2026-05-13", slot: "dinner" },
			"bean patty",
			"chicken patty",
		);
		const removedNames = swapPreview.affected_shopping.removed.map(i => i.name.toLowerCase());
		const addedNames = swapPreview.affected_shopping.added.map(i => i.name.toLowerCase());
		ctx.notes.push(`removed: ${removedNames.join(", ")}`);
		ctx.notes.push(`added: ${addedNames.join(", ")}`);
		ctx.assert.ok(removedNames.some(n => n.includes("bean") && n.includes("patty")), "bean patty removed from shopping");
		ctx.assert.ok(addedNames.some(n => n.includes("chicken") && n.includes("patty")), "chicken patty added to shopping");

		// (4) commit with unknown id throws.
		let threw = false;
		try {
			commit(plan, "not_a_real_proposal");
		} catch {
			threw = true;
		}
		ctx.assert.eq(threw, true, "commit with unknown proposal_id throws");
	},
};

function makeMinimalPlan(): MiseWeeklyPlanDraft {
	const wed = makeMeal({
		id: "meal:wed_dinner",
		date: "2026-05-13",
		slot: "dinner",
		title: "Smashburger",
		format: "burger",
		ingredient_names: ["bean patty", "brioche bun"],
		raw_ingredients: [
			{ name: "bean patty", qty: 4, unit: "piece", grams: 480, category: null },
			{ name: "brioche bun", qty: 4, unit: "piece", grams: 280, category: null },
		],
	});
	return {
		id: "mise_plan:u07",
		household_id: "test",
		title: "U07 fixture",
		start_date: "2026-05-13",
		end_date: "2026-05-17",
		timezone: "UTC",
		people: 2,
		status: "draft",
		constraints: {},
		selected_ingredients: [],
		source_recipe_ids: [],
		meals_by_day: [
			{ date: "2026-05-13", day_index: 0, meals: [wed] },
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
		raw_ingredients: partial.raw_ingredients,
		leftovers_to: partial.leftovers_to,
	};
}

export default u07;
