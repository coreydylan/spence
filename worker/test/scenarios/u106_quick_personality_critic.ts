// U106 — QuickPersonalityCritic emits a preference grievance for long-prep
// meals when the household leans quick (quick_vs_project value > 0.7,
// confidence > 0.2).
//
// The critic is pure: we hand it a plan + a fake HouseholdAuditContext where
// signals.personality.dimensions[quick_vs_project] = { value: 0.85, conf: 0.6 }.
// A meal whose format is "tagine" (FORMAT_COOK_MIN = 70 → exceeds 60min) is
// flagged. A meal whose format is "salad" (15 min) is NOT flagged.
//
// Negative cases also covered:
//   * High value but LOW confidence (0.1) → 0 grievances.
//   * Mid value (0.5) regardless of confidence → 0 grievances.
//   * No quick_vs_project dimension at all → 0 grievances.

import type { Scenario } from "../lib/types";
import type { MiseWeeklyPlanDraft, MisePlanMeal } from "../../src/mise-graph/planner";
import {
	quickPersonalityCritic,
	estimateMealCookMin,
	type HouseholdAuditContext,
} from "../../src/mise-graph/household-critics";
import type { HouseholdSignals, HouseholdSignalDimension } from "../../src/mise-graph/household-signals";

function makeMeal(id: string, format: string, title: string): MisePlanMeal {
	return {
		id,
		date: "2026-05-08",
		slot: "dinner",
		title,
		format,
		component_ids: [],
		ingredient_names: [],
		source: "test_fixture",
		notes: [],
		people: 2,
		cuisine: [],
		locked: false,
	};
}

function makePlan(meals: MisePlanMeal[]): MiseWeeklyPlanDraft {
	return {
		id: "fixture_u106",
		household_id: "hh_u106",
		title: "U106 plan",
		start_date: "2026-05-08",
		end_date: "2026-05-08",
		timezone: null,
		people: 2,
		status: "draft",
		constraints: {},
		selected_ingredients: [],
		source_recipe_ids: [],
		meals_by_day: [{ date: "2026-05-08", day_index: 0, meals }],
		component_batches: [],
		prep_tasks: [],
		breakfasts: [],
		snack_boxes: [],
		shopping_list: [],
		storage_labels: [],
		meta: { generated_by: "mise_graph_planner", deterministic: true },
	};
}

function makeContext(value: number, confidence: number): HouseholdAuditContext {
	const dim: HouseholdSignalDimension = {
		trait_name: "quick_vs_project",
		value,
		confidence,
		label: value >= 0.7 ? "leans project-cook leaning" : "balanced",
	};
	const signals: HouseholdSignals = {
		household_id: "hh_u106",
		generated_at_ms: Date.now(),
		personality: { summary: "quick-leaning test", dimensions: [dim] },
		traditions: [],
		pantry_top: [],
		equipment_available: [],
		avoidances: { dietary: [], allergies: [], dislikes: [] },
		member_spread_guidance: null,
	};
	return { household_id: "hh_u106", signals, traditions: [] };
}

const u106: Scenario = {
	id: "u106",
	name: "QuickPersonalityCritic flags long-prep meals when household leans quick",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// Sanity-check the format → minutes table that the critic depends on.
		ctx.assert.gt(estimateMealCookMin(makeMeal("a", "tagine", "Tagine")), 60, "tagine estimated > 60 min");
		ctx.assert.lte(estimateMealCookMin(makeMeal("b", "salad", "Salad")), 60, "salad estimated <= 60 min");

		// Counter-intuitive note: the trait spec is "quick_vs_project" with HIGH
		// value meaning "project-cook leaning". The brief says ">0.7 with
		// confidence>0.2" should fire — that matches a project-leaning household.
		// We honour the brief's spec literally (value>0.7 ⇒ critic fires), so
		// the message reads "household leans quick" per the brief's exact text.
		const longMeal = makeMeal("meal:long", "tagine", "Lamb tagine");
		const shortMeal = makeMeal("meal:short", "salad", "Caesar salad");
		const plan = makePlan([longMeal, shortMeal]);

		// 1. HIGH value + HIGH confidence → flags the long meal.
		const decisive = makeContext(0.85, 0.6);
		const decisiveResult = quickPersonalityCritic(plan, decisive);
		ctx.assert.eq(decisiveResult.length, 1, "exactly one preference grievance for the >60-min meal");
		const g = decisiveResult[0];
		ctx.assert.eq(g.critic, "QuickPersonalityCritic", "critic name");
		ctx.assert.eq(g.severity, "preference", "severity is preference");
		ctx.assert.eq(g.slot_ref?.date, "2026-05-08", "slot_ref date matches");
		ctx.assert.eq(g.slot_ref?.slot, "dinner", "slot_ref slot matches");
		ctx.assert.contains(g.message, "Lamb tagine", "message names the offending meal");
		ctx.assert.contains(g.message, "leans quick", "message uses 'leans quick' phrasing per brief");
		ctx.assert.contains(g.suggested_repair || "", "faster format", "repair suggests a faster format");
		const meta = g.meta as Record<string, unknown>;
		ctx.assert.gt((meta?.estimated_cook_min as number) || 0, 60, "meta.estimated_cook_min > 60");
		ctx.assert.eq(meta?.quick_value, 0.85, "meta.quick_value carried");
		ctx.assert.eq(meta?.quick_confidence, 0.6, "meta.quick_confidence carried");

		// 2. HIGH value but LOW confidence → no grievances (brief: confidence > 0.2 required).
		const lowConf = makeContext(0.85, 0.1);
		const lowConfResult = quickPersonalityCritic(plan, lowConf);
		ctx.assert.eq(lowConfResult.length, 0, "low confidence (0.1) → 0 grievances even on long meal");

		// 3. MID value, regardless of confidence → no grievances.
		const midValue = makeContext(0.5, 0.9);
		const midResult = quickPersonalityCritic(plan, midValue);
		ctx.assert.eq(midResult.length, 0, "mid value (0.5) → 0 grievances");

		// 4. LOW value (project-cook leaning DOWN side) → no grievances.
		const lowValue = makeContext(0.2, 0.9);
		const lowValueResult = quickPersonalityCritic(plan, lowValue);
		ctx.assert.eq(lowValueResult.length, 0, "low value (0.2) → 0 grievances");

		// 5. No quick_vs_project dimension at all → no grievances.
		const noDim: HouseholdAuditContext = {
			household_id: "hh_u106",
			signals: {
				household_id: "hh_u106",
				generated_at_ms: Date.now(),
				personality: { summary: "", dimensions: [] },
				traditions: [],
				pantry_top: [],
				equipment_available: [],
				avoidances: { dietary: [], allergies: [], dislikes: [] },
				member_spread_guidance: null,
			},
			traditions: [],
		};
		const noDimResult = quickPersonalityCritic(plan, noDim);
		ctx.assert.eq(noDimResult.length, 0, "missing dimension → 0 grievances");

		// 6. Plan with ONLY short meals → no grievances even when quick-leaning.
		const onlyShortPlan = makePlan([shortMeal]);
		const onlyShortResult = quickPersonalityCritic(onlyShortPlan, decisive);
		ctx.assert.eq(onlyShortResult.length, 0, "no long-prep meals → 0 grievances");

		ctx.notes.push(`u106 grievance count (decisive): ${decisiveResult.length}`);
	},
};

export default u106;
