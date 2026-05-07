// U105 — TraditionRespectCritic emits a preference grievance when a meal
// scheduled on a tradition's cadence date doesn't honor the tradition.
//
// The critic is pure: it takes (plan, householdContext) — no DB. We construct
// a fake context with a "Friday Pizza Night" tradition (must_include_format =
// "pizza") and a plan where the Friday dinner is a pasta. We expect one
// preference grievance pointing at that slot. A separately-constructed plan
// where the Friday dinner IS a pizza (matching must_include_format) emits 0
// grievances.

import type { Scenario } from "../lib/types";
import type { MiseWeeklyPlanDraft } from "../../src/mise-graph/planner";
import {
	traditionRespectCritic,
	cadenceMatchesDate,
	type HouseholdAuditContext,
	type TraditionWithMeta,
} from "../../src/mise-graph/household-critics";
import type { HouseholdSignals } from "../../src/mise-graph/household-signals";

function emptySignals(household_id: string): HouseholdSignals {
	return {
		household_id,
		generated_at_ms: Date.now(),
		personality: { summary: "", dimensions: [] },
		traditions: [],
		pantry_top: [],
		equipment_available: [],
		avoidances: { dietary: [], allergies: [], dislikes: [] },
		member_spread_guidance: null,
	};
}

function makePlan(opts: { friday_format: string; friday_title: string }): MiseWeeklyPlanDraft {
	// 2026-05-08 is a Friday (verified: getUTCDay() === 5).
	return {
		id: "fixture_u105",
		household_id: "hh_u105",
		title: "U105 plan",
		start_date: "2026-05-08",
		end_date: "2026-05-08",
		timezone: null,
		people: 2,
		status: "draft",
		constraints: {},
		selected_ingredients: [],
		source_recipe_ids: [],
		meals_by_day: [{
			date: "2026-05-08",
			day_index: 0,
			meals: [{
				id: "meal:friday_dinner",
				date: "2026-05-08",
				slot: "dinner",
				title: opts.friday_title,
				format: opts.friday_format,
				component_ids: [],
				ingredient_names: [],
				source: "test_fixture",
				notes: [],
				people: 2,
				cuisine: [],
				locked: false,
			}],
		}],
		component_batches: [],
		prep_tasks: [],
		breakfasts: [],
		snack_boxes: [],
		shopping_list: [],
		storage_labels: [],
		meta: { generated_by: "mise_graph_planner", deterministic: true },
	};
}

const u105: Scenario = {
	id: "u105",
	name: "TraditionRespectCritic flags Friday dinner that doesn't honor Friday Pizza Night",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// Sanity check the cadence helper before relying on it for the rest.
		ctx.assert.ok(cadenceMatchesDate("weekly:friday", "2026-05-08"), "2026-05-08 is a Friday");
		ctx.assert.ok(!cadenceMatchesDate("weekly:friday", "2026-05-09"), "2026-05-09 is NOT a Friday");
		ctx.assert.ok(!cadenceMatchesDate("monthly:1st-friday", "2026-05-08"), "non-weekly cadence skipped");

		const tradition: TraditionWithMeta = {
			tradition_id: "trad_pizza",
			name: "Friday Pizza Night",
			cadence: "weekly:friday",
			must_include_format: "pizza",
			must_include: ["mozzarella"],
		};
		const context: HouseholdAuditContext = {
			household_id: "hh_u105",
			signals: emptySignals("hh_u105"),
			traditions: [tradition],
		};

		// 1. VIOLATION — Friday dinner is a pasta, not a pizza.
		const violatingPlan = makePlan({ friday_format: "pasta", friday_title: "Cacio e pepe" });
		const violations = traditionRespectCritic(violatingPlan, context);
		ctx.assert.eq(violations.length, 1, "exactly one preference grievance for the unmatched Friday dinner");
		const g = violations[0];
		ctx.assert.eq(g.critic, "TraditionRespectCritic", "critic name");
		ctx.assert.eq(g.severity, "preference", "severity is preference (low-severity nudge)");
		ctx.assert.eq(g.slot_ref?.date, "2026-05-08", "slot_ref date matches");
		ctx.assert.eq(g.slot_ref?.slot, "dinner", "slot_ref slot matches");
		ctx.assert.contains(g.message, "Friday Pizza Night", "message names the tradition");
		ctx.assert.contains(g.message, "Cacio e pepe", "message names the offending meal");
		ctx.assert.contains(g.suggested_repair || "", "pizza", "repair hint suggests the expected format");
		ctx.assert.eq((g.meta as Record<string, unknown>)?.tradition_id, "trad_pizza", "meta carries tradition_id");
		ctx.assert.eq((g.meta as Record<string, unknown>)?.expected_format, "pizza", "meta carries expected_format");

		// 2. NO VIOLATION — Friday dinner IS a pizza (format matches).
		const honoringPlan = makePlan({ friday_format: "pizza", friday_title: "Margherita" });
		const honored = traditionRespectCritic(honoringPlan, context);
		ctx.assert.eq(honored.length, 0, "no grievance when format matches must_include_format");

		// 3. NO VIOLATION — Friday dinner title contains a tradition keyword
		// (case-insensitive). e.g. format is "flatbread" but title says "Pizza
		// flatbread" — should be honored via the keyword fallback.
		const keywordPlan = makePlan({ friday_format: "flatbread", friday_title: "Pizza-style flatbread" });
		const keywordResult = traditionRespectCritic(keywordPlan, context);
		ctx.assert.eq(keywordResult.length, 0, "title keyword 'pizza' honors the tradition even when format differs");

		// 4. NO TRADITIONS → no grievances.
		const emptyContext: HouseholdAuditContext = {
			household_id: "hh_u105",
			signals: emptySignals("hh_u105"),
			traditions: [],
		};
		const emptyResult = traditionRespectCritic(violatingPlan, emptyContext);
		ctx.assert.eq(emptyResult.length, 0, "no traditions → no grievances regardless of plan");

		// 5. CADENCE MISMATCH — meal on a non-Friday with a Friday-cadence
		// tradition emits 0 grievances (the tradition doesn't apply that day).
		const saturdayPlan: MiseWeeklyPlanDraft = {
			...violatingPlan,
			start_date: "2026-05-09",
			end_date: "2026-05-09",
			meals_by_day: [{
				date: "2026-05-09",
				day_index: 0,
				meals: [{
					...violatingPlan.meals_by_day[0].meals[0],
					id: "meal:saturday_dinner",
					date: "2026-05-09",
				}],
			}],
		};
		const saturdayResult = traditionRespectCritic(saturdayPlan, context);
		ctx.assert.eq(saturdayResult.length, 0, "cadence mismatch (Saturday vs Friday tradition) → 0 grievances");

		ctx.notes.push(`u105 violating message: "${g.message.slice(0, 80)}…"`);
	},
};

export default u105;
