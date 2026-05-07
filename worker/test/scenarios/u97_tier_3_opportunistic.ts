// U97 — Tier 3 hook predicates are opportunistic (calendar-gated).
//
// Confirms:
//   * tier_3_sunday_tradition only fires when is_sunday_morning is true
//     (Sun 06:00–11:59 UTC).
//   * tier_3_holiday_approach fires when days_until_next_holiday ≤ 7.
//   * tier_3_tired_night_default fires when the user has mentioned "tired"
//     in a recent free-text response.
//   * tier_3_loved_meal_followup fires when there's a recent_high_taste_meal_id
//     (signal Phase D-but-Phase-C-extended).
//   * Trigger predicates without their underlying signal stay quiet.

import type { Scenario } from "../lib/types";
import { createMockD1 } from "../lib/mock-d1";
import { migrateHouseholdMemorySchema } from "../../src/mise-graph/admin-household-memory";
import { migrateOnboardingSchema } from "../../src/mise-graph/schemas/migrations";
import { startOnboarding, answerOnboarding } from "../../src/mise-graph/onboarding";
import {
	computeHookDeps,
	evaluateHook,
	evaluateTrigger,
} from "../../src/mise-graph/onboarding-hooks";
import {
	TIER_3_QUESTIONS,
	findHookedQuestion,
	getQuestionsForTier,
} from "../../src/mise-graph/onboarding-questions";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

const u97: Scenario = {
	id: "u97",
	name: "Phase D tier 3 hook predicates are opportunistic / calendar-gated",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const db = createMockD1();
		const env = { DB: db as unknown as D1Database } as MiseGraphEnv;
		await migrateHouseholdMemorySchema(env);
		await migrateOnboardingSchema(env);

		await startOnboarding(env, { household_id: "hh_u97" });

		// 1. Tier 3 bank shape ---------------------------------------------------
		ctx.assert.gte(TIER_3_QUESTIONS.length, 6, "tier 3 bank has ≥6 hooked questions");
		const tier3Set = getQuestionsForTier(3);
		ctx.assert.eq(tier3Set.length, TIER_3_QUESTIONS.length, "getQuestionsForTier(3) returns the bank");
		for (const q of TIER_3_QUESTIONS) {
			ctx.assert.eq(q.tier, 3, `${q.kind} is tier 3`);
		}

		// 2. Sunday tradition fires ONLY on Sunday morning ---------------------
		// Thursday May 7 2026 12:00 UTC — should NOT fire.
		const thursdayNoon = Date.parse("2026-05-07T12:00:00Z");
		const depsThursday = await computeHookDeps(env, "hh_u97", thursdayNoon);
		ctx.assert.eq(depsThursday.is_sunday_morning, false, "thursday noon is not sunday morning");
		ctx.assert.eq(evaluateTrigger("sunday_morning", depsThursday), false, "sunday_morning trigger silent on thursday");

		// Sunday May 10 2026 09:00 UTC — should fire.
		const sundayMorning = Date.parse("2026-05-10T09:00:00Z");
		const depsSunday = await computeHookDeps(env, "hh_u97", sundayMorning);
		ctx.assert.eq(depsSunday.is_sunday_morning, true, "sunday 09:00 is sunday morning");
		ctx.assert.eq(evaluateTrigger("sunday_morning", depsSunday), true, "sunday_morning trigger fires on sunday");

		const sundayQ = findHookedQuestion("tier_3_sunday_tradition");
		ctx.assert.ok(!!sundayQ, "tier_3_sunday_tradition exists in bank");
		const sundayEval = evaluateHook(sundayQ!, depsSunday);
		ctx.assert.eq(sundayEval.fires, true, "sunday question fires on sunday morning");
		ctx.assert.eq(sundayEval.bonus, 1.5, "fires → bonus 1.5");

		const sundayThursdayEval = evaluateHook(sundayQ!, depsThursday);
		ctx.assert.eq(sundayThursdayEval.fires, false, "sunday question silent on thursday");
		ctx.assert.eq(sundayThursdayEval.bonus, 1.0, "no fire → bonus 1.0");

		// Sunday EVENING (after noon UTC) should NOT fire — sunday_morning
		// is the explicit gate, and we want to avoid asking deep tradition
		// questions late in the day.
		const sundayEvening = Date.parse("2026-05-10T18:00:00Z");
		const depsSundayEvening = await computeHookDeps(env, "hh_u97", sundayEvening);
		ctx.assert.eq(depsSundayEvening.is_sunday_morning, false, "sunday evening is not sunday morning");
		ctx.assert.eq(evaluateTrigger("sunday_morning", depsSundayEvening), false, "sunday_morning trigger silent in evening");

		// 3. Holiday approach trigger ------------------------------------------
		// 3 days before Thanksgiving (Nov 28). Compute deps on Nov 25 2026.
		const preThanksgiving = Date.parse("2026-11-25T12:00:00Z");
		const depsHoliday = await computeHookDeps(env, "hh_u97", preThanksgiving);
		ctx.assert.ok(typeof depsHoliday.days_until_next_holiday === "number", "holiday days computed");
		ctx.assert.lte(depsHoliday.days_until_next_holiday!, 7, "thanksgiving is ≤7 days out");
		ctx.assert.eq(evaluateTrigger("holiday_approach", depsHoliday), true, "holiday_approach fires within 7 days");

		// 4. Tired-mention trigger ---------------------------------------------
		// Insert a free-text response that mentions "tired". Use answerOnboarding
		// on the optional tier_1_members_roster question so we don't break the
		// tier-advance flow.
		await answerOnboarding(env, {
			household_id: "hh_u97",
			question_kind: "tier_1_members_roster",
			response_text: "It's just me and Sam, both tired this week",
		});
		const depsTired = await computeHookDeps(env, "hh_u97", thursdayNoon);
		ctx.assert.gte(depsTired.tired_mentions_recent, 1, "tired mention parsed from response log");
		ctx.assert.eq(evaluateTrigger("tired_night_default", depsTired), true, "tired trigger fires");

		// 5. Loved meal trigger fires when signal present ----------------------
		const depsLoved = { ...depsTired, recent_high_taste_meal_id: "meal_x", recent_high_taste_meal_label: "Tofu Larb" };
		ctx.assert.eq(evaluateTrigger("loved_meal_followup", depsLoved), true, "loved_meal_followup fires when signal present");
		const lovedQ = findHookedQuestion("tier_3_loved_meal_followup");
		ctx.assert.ok(!!lovedQ, "tier_3_loved_meal_followup exists in bank");
		const lovedEval = evaluateHook(lovedQ!, depsLoved);
		ctx.assert.contains(lovedEval.rendered_text, "Tofu Larb", "loved meal template renders meal label");

		// 6. Quiet baseline -- no signal means no fire (except long-term ones) -
		const depsQuiet = await computeHookDeps(env, "hh_u97", thursdayNoon);
		// Tier 3 calendar-driven (sunday/holiday/loved/cancel/perfect/tired_pattern) all silent here.
		ctx.assert.eq(evaluateTrigger("loved_meal_followup", depsQuiet), false, "loved_meal silent without signal");
		ctx.assert.eq(evaluateTrigger("holiday_approach", depsQuiet), false, "holiday silent on May 7");
		ctx.assert.eq(evaluateTrigger("perfect_on_paper", depsQuiet), false, "perfect_on_paper not yet wired (Phase C dependency)");

		ctx.notes.push(`u97 tier 3 question count: ${TIER_3_QUESTIONS.length}`);
	},
};

export default u97;
