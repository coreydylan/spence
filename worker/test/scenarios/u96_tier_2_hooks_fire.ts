// U96 — Tier 2 hook predicates fire from runtime HookDeps.
//
// Confirms:
//   * computeHookDeps() reads engagement signal + onboarding state and surfaces
//     calendar-derived signals (is_weekend / current_month) without crashing
//     when meal-signals tables are absent.
//   * evaluateTrigger("cuisine_streak", deps) fires when streak ≥ 3.
//   * evaluateTrigger("anchor_repeat", deps) fires when an ingredient has
//     ≥4 occurrences.
//   * evaluateHook() returns bonus=1.5 when fires and renders the template
//     with the actual count ("Tofu's shown up 4 times").
//   * Trigger does NOT fire when the dep is below threshold.

import type { Scenario } from "../lib/types";
import { createMockD1 } from "../lib/mock-d1";
import { migrateHouseholdMemorySchema } from "../../src/mise-graph/admin-household-memory";
import { migrateOnboardingSchema } from "../../src/mise-graph/schemas/migrations";
import { startOnboarding, answerOnboarding } from "../../src/mise-graph/onboarding";
import {
	computeHookDeps,
	evaluateHook,
	evaluateTrigger,
	renderTemplate,
} from "../../src/mise-graph/onboarding-hooks";
import {
	TIER_2_QUESTIONS,
	findHookedQuestion,
	getQuestionsForTier,
} from "../../src/mise-graph/onboarding-questions";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

const u96: Scenario = {
	id: "u96",
	name: "Phase D tier 2 hook predicates fire from runtime deps",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const db = createMockD1();
		const env = { DB: db as unknown as D1Database } as MiseGraphEnv;
		await migrateHouseholdMemorySchema(env);
		await migrateOnboardingSchema(env);

		// Tier 0 + a partial answer so engagement_signal exists. computeHookDeps
		// should still work even without a full tier walk.
		await startOnboarding(env, { household_id: "hh_u96" });
		await answerOnboarding(env, { household_id: "hh_u96", question_kind: "tier_0_size", response_text: "2" });

		// 1. Tier 2 question bank shape ------------------------------------------
		ctx.assert.gte(TIER_2_QUESTIONS.length, 6, "tier 2 bank has ≥6 hooked questions");
		const kinds = new Set(TIER_2_QUESTIONS.map(q => q.kind));
		ctx.assert.eq(kinds.size, TIER_2_QUESTIONS.length, "tier 2 kinds are unique");
		for (const q of TIER_2_QUESTIONS) {
			ctx.assert.eq(q.tier, 2, `${q.kind} is tier 2`);
			ctx.assert.eq(typeof q.trigger_kind, "string", `${q.kind} declares trigger_kind`);
			ctx.assert.gt(q.text_template.length, 0, `${q.kind} has a non-empty template`);
		}

		// 2. getQuestionsForTier returns tier 2 ----------------------------------
		const tier2Set = getQuestionsForTier(2);
		ctx.assert.eq(tier2Set.length, TIER_2_QUESTIONS.length, "getQuestionsForTier(2) returns the bank");

		// 3. computeHookDeps with no meal_signals table -- defaults stand --------
		const now = Date.parse("2026-05-07T12:00:00Z");
		const depsBaseline = await computeHookDeps(env, "hh_u96", now);
		ctx.assert.eq(depsBaseline.recent_cancellations, 0, "no cancellations in baseline");
		ctx.assert.eq(depsBaseline.dominant_cuisine_streak, 0, "no cuisine streak in baseline");
		ctx.assert.eq(depsBaseline.repeat_ingredient, null, "no anchor in baseline");
		ctx.assert.eq(depsBaseline.current_month, 5, "May = month 5");
		ctx.assert.eq(depsBaseline.is_weekend, false, "Thursday is not weekend");
		ctx.assert.eq(depsBaseline.is_sunday_morning, false, "Thursday is not sunday morning");

		// 4. None of the tier 2 triggers fire on baseline -----------------------
		for (const q of TIER_2_QUESTIONS) {
			const fires = evaluateTrigger(q.trigger_kind, depsBaseline);
			ctx.assert.eq(fires, false, `tier_2 ${q.trigger_kind} does not fire on baseline deps`);
		}

		// 5. Synthesize a cuisine streak + anchor in deps and re-evaluate -------
		const depsHot = {
			...depsBaseline,
			dominant_cuisine_streak: 4,
			dominant_cuisine: "italian",
			repeat_ingredient: "tofu",
			repeat_ingredient_count: 4,
		};
		ctx.assert.eq(evaluateTrigger("cuisine_streak", depsHot), true, "cuisine_streak fires when streak ≥3");
		ctx.assert.eq(evaluateTrigger("anchor_repeat", depsHot), true, "anchor_repeat fires when ingredient repeats ≥4");
		ctx.assert.eq(evaluateTrigger("skipped_meal", depsHot), false, "skipped_meal stays false without cancellations");

		// 6. evaluateHook returns bonus=1.5 + template-rendered text ------------
		const cuisineQ = findHookedQuestion("tier_2_cuisine_streak");
		ctx.assert.ok(!!cuisineQ, "tier_2_cuisine_streak exists in bank");
		const cuisineEval = evaluateHook(cuisineQ!, depsHot);
		ctx.assert.eq(cuisineEval.fires, true, "cuisine_streak evaluator fires");
		ctx.assert.eq(cuisineEval.bonus, 1.5, "fires → bonus 1.5");
		ctx.assert.contains(cuisineEval.rendered_text, "italian", "rendered text contains the cuisine name");
		ctx.assert.contains(cuisineEval.rendered_text, "4", "rendered text contains streak length");

		const anchorQ = findHookedQuestion("tier_2_anchor_repeat");
		ctx.assert.ok(!!anchorQ, "tier_2_anchor_repeat exists in bank");
		const anchorEval = evaluateHook(anchorQ!, depsHot);
		ctx.assert.eq(anchorEval.fires, true, "anchor evaluator fires");
		ctx.assert.contains(anchorEval.rendered_text, "tofu", "rendered text contains the ingredient");
		ctx.assert.contains(anchorEval.rendered_text, "4", "rendered text contains the count");

		// 7. evaluateHook on a non-firing question returns bonus=1.0 ------------
		const skipQ = findHookedQuestion("tier_2_skipped_meal");
		ctx.assert.ok(!!skipQ, "tier_2_skipped_meal exists in bank");
		const skipEval = evaluateHook(skipQ!, depsHot);
		ctx.assert.eq(skipEval.fires, false, "skipped_meal does not fire without cancellations");
		ctx.assert.eq(skipEval.bonus, 1.0, "no fire → bonus 1.0");

		// 8. renderTemplate gracefully handles missing keys --------------------
		const safe = renderTemplate("Some ${not_a_real_key} fallback ${repeat_ingredient}", depsHot);
		ctx.assert.contains(safe, "Some  fallback tofu", "missing keys render as empty string");

		// 9. Equipment unused trigger fires when equipment_json present --------
		// Seed a profile row directly (writeback only fires for known column
		// answers like dinner_ritual; we skip that to keep the test focused).
		const nowIso = new Date(now).toISOString();
		await env.DB.prepare(
			`INSERT OR REPLACE INTO mise_household_profiles
				(household_id, display_name, people_count, dietary_json, equipment_json,
				 current_anchors_json, cuisine_preferences_json, default_pantry_json,
				 shop_preferences_json, notes, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind("hh_u96", null, 2, "[]", JSON.stringify(["dutch oven", "instant pot"]),
			"[]", "{}", "[]", null, null, nowIso, nowIso).run();
		const depsWithEquip = await computeHookDeps(env, "hh_u96", now);
		ctx.assert.gt(depsWithEquip.idle_equipment.length, 0, "equipment list surfaces as idle when no claims table");
		ctx.assert.eq(evaluateTrigger("equipment_unused", depsWithEquip), true, "equipment_unused fires when idle list non-empty");
		const equipQ = findHookedQuestion("tier_2_equipment_unused");
		const equipRendered = evaluateHook(equipQ!, depsWithEquip).rendered_text;
		ctx.assert.contains(equipRendered, "dutch oven", "equipment template renders the actual label");

		ctx.notes.push(`u96 tier 2 question count: ${TIER_2_QUESTIONS.length}`);
	},
};

export default u96;
