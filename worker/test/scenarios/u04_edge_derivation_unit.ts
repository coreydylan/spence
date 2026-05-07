// U4 — Unit tests for deriveDependencyEdges() + helpers.
//
// Three small cases exercise the boundary conditions:
//   (1) Empty plan → empty edge list.
//   (2) Plan with only meals (no batches, no tasks, no shop_runs) → only the
//       Meal→Meal leftover edges that the meals themselves declare.
//   (3) Plan with a leftover claim that spans 5 days → status === 'violated'
//       (rule value 72h, current lead 120h, slack -48h).

import type { Scenario } from "../lib/types";
import {
	deriveDependencyEdges,
	edgesViolated,
} from "../../src/mise-graph/dependency-edges";
import type {
	MiseWeeklyPlanDraft,
	MisePlanMeal,
} from "../../src/mise-graph/planner";

const u04: Scenario = {
	id: "u04",
	name: "deriveDependencyEdges handles empty plan, leftover-only plan, and stale leftover claims",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// ------------------------------------------------------------------
		// (1) Empty plan → empty edge list.
		// ------------------------------------------------------------------
		const emptyPlan = makePlan({ meals: [] });
		const emptyEdges = deriveDependencyEdges(emptyPlan);
		ctx.notes.push(`empty plan edges: ${emptyEdges.length}`);
		ctx.assert.eq(emptyEdges.length, 0, "empty plan produces zero edges");

		// ------------------------------------------------------------------
		// (2) Plan with only meals: meal A on Mon claims leftover_to Tue lunch.
		//     Should produce exactly one Meal→Meal leftover edge (status ok).
		// ------------------------------------------------------------------
		const monMeal: MisePlanMeal = makeMeal({
			id: "meal:mon_dinner",
			date: "2026-05-11",
			slot: "dinner",
			title: "Big Pot of Lentils",
			leftovers_to: ["2026-05-12 lunch"],
		});
		const tueLunch: MisePlanMeal = makeMeal({
			id: "meal:tue_lunch",
			date: "2026-05-12",
			slot: "lunch",
			title: "Lentil Lunch (leftover)",
		});
		const mealOnlyPlan = makePlan({
			meals: [
				{ date: "2026-05-11", day_index: 0, meals: [monMeal] },
				{ date: "2026-05-12", day_index: 1, meals: [tueLunch] },
			],
		});
		const mealOnlyEdges = deriveDependencyEdges(mealOnlyPlan);
		ctx.notes.push(`meal-only plan edges: ${mealOnlyEdges.length}`);
		const leftoverEdges = mealOnlyEdges.filter(e =>
			e.from.entity_type === "Meal" && e.to.entity_type === "Meal",
		);
		ctx.assert.eq(leftoverEdges.length, 1, "exactly one Meal→Meal leftover edge");
		ctx.assert.eq(leftoverEdges[0].rule.kind, "leftover_window", "rule kind is leftover_window");
		ctx.assert.eq(leftoverEdges[0].rule.value, 72, "default leftover window is 72h");
		ctx.assert.eq(leftoverEdges[0].current_lead_time_hours, 24, "current lead Mon dinner → Tue lunch is 24h");
		ctx.assert.eq(leftoverEdges[0].status, "ok", "24h within 72h window → status ok");
		// All edges in this plan are meal→meal (no shop, no cook).
		ctx.assert.eq(leftoverEdges.length, mealOnlyEdges.length, "no other edge kinds when there are no batches/tasks/shop_runs");

		// ------------------------------------------------------------------
		// (3) Leftover claim spanning 5 days (120h) → status === 'violated'.
		// ------------------------------------------------------------------
		const monMeal2: MisePlanMeal = makeMeal({
			id: "meal:mon_dinner",
			date: "2026-05-11",
			slot: "dinner",
			title: "Pot of Stew",
			leftovers_to: ["2026-05-16 lunch"], // 5 days later
		});
		const satLunch: MisePlanMeal = makeMeal({
			id: "meal:sat_lunch",
			date: "2026-05-16",
			slot: "lunch",
			title: "Stew Lunch (stale!)",
		});
		const stalePlan = makePlan({
			meals: [
				{ date: "2026-05-11", day_index: 0, meals: [monMeal2] },
				{ date: "2026-05-16", day_index: 5, meals: [satLunch] },
			],
		});
		const staleEdges = deriveDependencyEdges(stalePlan);
		const violations = edgesViolated(staleEdges);
		ctx.notes.push(`stale-leftover plan: total=${staleEdges.length} violated=${violations.length}`);
		ctx.assert.eq(violations.length, 1, "one violated edge on the 5-day leftover claim");
		const v = violations[0];
		ctx.assert.eq(v.rule.kind, "leftover_window", "violated rule is leftover_window");
		ctx.assert.eq(v.current_lead_time_hours, 120, "current lead is 120h (5 days)");
		ctx.assert.eq(v.slack_hours, 72 - 120, "slack is -48h (under 72h window by 48h)");
		ctx.assert.eq(v.status, "violated", "status is violated");
	},
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

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
	};
}

function makePlan(args: { meals: Array<{ date: string; day_index: number; meals: MisePlanMeal[] }> }): MiseWeeklyPlanDraft {
	return {
		id: "mise_plan:unit_test",
		household_id: null,
		title: "U04 unit fixture",
		start_date: "2026-05-11",
		end_date: "2026-05-17",
		timezone: null,
		people: 2,
		status: "draft",
		constraints: {},
		selected_ingredients: [],
		source_recipe_ids: [],
		meals_by_day: args.meals,
		component_batches: [],
		prep_tasks: [],
		breakfasts: [],
		snack_boxes: [],
		shopping_list: [],
		storage_labels: [],
		meta: { generated_by: "mise_graph_planner", deterministic: true },
	};
}

export default u04;
