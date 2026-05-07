// U108 — MemberSpreadCritic emits a single meta-grievance per plan when
// signals.member_spread_guidance is non-null, anchored to the first meal in
// the plan (chronologically by date+slot).
//
// Design: it's one nudge per plan, not per meal — the guidance is a
// household-level fact, not a slot-level violation. Anchoring to the first
// meal gives the renderer a concrete slot_ref to display.

import type { Scenario } from "../lib/types";
import type { MiseWeeklyPlanDraft, MisePlanMeal } from "../../src/mise-graph/planner";
import {
	memberSpreadCritic,
	type HouseholdAuditContext,
} from "../../src/mise-graph/household-critics";
import type { HouseholdSignals } from "../../src/mise-graph/household-signals";

function makeMeal(id: string, date: string, slot: "breakfast" | "lunch" | "dinner" | "snack"): MisePlanMeal {
	return {
		id,
		date,
		slot,
		title: `meal at ${date} ${slot}`,
		format: "bowl",
		component_ids: [],
		ingredient_names: [],
		source: "test_fixture",
		notes: [],
		people: 2,
		cuisine: [],
		locked: false,
	};
}

function makePlan(meals: MisePlanMeal[], breakfasts: MisePlanMeal[] = []): MiseWeeklyPlanDraft {
	const byDate = new Map<string, MisePlanMeal[]>();
	for (const m of meals) {
		const arr = byDate.get(m.date) ?? [];
		arr.push(m);
		byDate.set(m.date, arr);
	}
	const days = [...byDate.entries()]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([date, dayMeals], idx) => ({ date, day_index: idx, meals: dayMeals }));
	return {
		id: "fixture_u108",
		household_id: "hh_u108",
		title: "U108 plan",
		start_date: days[0]?.date ?? "2026-05-08",
		end_date: days.at(-1)?.date ?? "2026-05-08",
		timezone: null,
		people: 2,
		status: "draft",
		constraints: {},
		selected_ingredients: [],
		source_recipe_ids: [],
		meals_by_day: days,
		component_batches: [],
		prep_tasks: [],
		breakfasts,
		snack_boxes: [],
		shopping_list: [],
		storage_labels: [],
		meta: { generated_by: "mise_graph_planner", deterministic: true },
	};
}

function makeContext(guidance: string | null): HouseholdAuditContext {
	const signals: HouseholdSignals = {
		household_id: "hh_u108",
		generated_at_ms: Date.now(),
		personality: { summary: "", dimensions: [] },
		traditions: [],
		pantry_top: [],
		equipment_available: [],
		avoidances: { dietary: [], allergies: [], dislikes: [] },
		member_spread_guidance: guidance,
	};
	return { household_id: "hh_u108", signals, traditions: [] };
}

const u108: Scenario = {
	id: "u108",
	name: "MemberSpreadCritic emits one meta-grievance anchored on the first meal",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const guidance = "Corey leans comfort while Katrina leans adventure on comfort_vs_adventure (divergence 0.65) — alternate or split.";

		// 1. DIVERGING — guidance non-null. Plan has Wednesday lunch, Wednesday
		// dinner, Thursday breakfast. Critic should emit ONE grievance anchored
		// on the earliest slot (Wed lunch by date+slot ordering).
		const wed_lunch = makeMeal("meal:wed_lunch", "2026-05-13", "lunch");
		const wed_dinner = makeMeal("meal:wed_dinner", "2026-05-13", "dinner");
		const thu_breakfast = makeMeal("meal:thu_breakfast", "2026-05-14", "breakfast");
		const plan = makePlan([wed_lunch, wed_dinner], [thu_breakfast]);
		const context = makeContext(guidance);

		const grievances = memberSpreadCritic(plan, context);
		ctx.assert.eq(grievances.length, 1, "exactly one meta-grievance per plan (not per meal)");
		const g = grievances[0];
		ctx.assert.eq(g.critic, "MemberSpreadCritic", "critic name");
		ctx.assert.eq(g.severity, "preference", "severity is preference");
		ctx.assert.eq(g.message, guidance, "message is verbatim guidance");
		ctx.assert.contains(g.suggested_repair || "", "alternating", "repair suggests alternating");
		// First meal = earliest date AND earliest slot ordering. Wed lunch (slot
		// order 2) precedes Wed dinner (slot order 4) on the same day.
		ctx.assert.eq(g.slot_ref?.date, "2026-05-13", "slot_ref anchored to earliest date");
		ctx.assert.eq(g.slot_ref?.slot, "lunch", "slot_ref anchored to earliest slot on that date");
		ctx.assert.eq((g.meta as Record<string, unknown>)?.anchor_meal_id, "meal:wed_lunch", "meta records anchor meal id");

		// 2. NULL guidance → 0 grievances.
		const nullContext = makeContext(null);
		const nullResult = memberSpreadCritic(plan, nullContext);
		ctx.assert.eq(nullResult.length, 0, "null guidance → 0 grievances");

		// 3. EMPTY plan (no meals at all) → 0 grievances (nowhere to anchor).
		const emptyPlan = makePlan([]);
		const emptyResult = memberSpreadCritic(emptyPlan, context);
		ctx.assert.eq(emptyResult.length, 0, "no meals → no anchor → 0 grievances");

		// 4. Anchor selection — when only a breakfast exists at the earliest
		// date, that breakfast becomes the anchor (slot order 1 < lunch=2).
		const onlyBreakfastPlan = makePlan([wed_lunch], [thu_breakfast]);
		// Meals_by_day has Wed lunch on 2026-05-13; breakfasts has Thu breakfast
		// on 2026-05-14. Earliest meal is Wed lunch — anchor stays there.
		const onlyBreakfastResult = memberSpreadCritic(onlyBreakfastPlan, context);
		ctx.assert.eq(onlyBreakfastResult[0].slot_ref?.date, "2026-05-13", "anchor honors earliest date across day-meals + breakfasts");

		ctx.notes.push(`u108 anchor: ${g.slot_ref?.date} ${g.slot_ref?.slot}`);
	},
};

export default u108;
