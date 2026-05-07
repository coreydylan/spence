// U85 — Onboarding Phase A lifecycle: tier 0 → tier 1, trait inference,
// completion %, and idempotent start.

import type { Scenario } from "../lib/types";
import { createMockD1 } from "../lib/mock-d1";
import { migrateHouseholdMemorySchema } from "../../src/mise-graph/admin-household-memory";
import { migrateOnboardingSchema } from "../../src/mise-graph/schemas/migrations";
import {
	answerOnboarding,
	listResponses,
	listTraits,
	skipOnboarding,
	startOnboarding,
	statusOnboarding,
} from "../../src/mise-graph/onboarding";
import { TIER_0_QUESTIONS, TIER_1_QUESTIONS } from "../../src/mise-graph/onboarding-questions";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

const u85: Scenario = {
	id: "u85",
	name: "Onboarding Phase A lifecycle: tier 0 → 1, trait inference, completion",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const db = createMockD1();
		const env = { DB: db as unknown as D1Database } as MiseGraphEnv;

		// Migrate household-memory first so the profile mirror writes work.
		await migrateHouseholdMemorySchema(env);
		const onboardingMigration = await migrateOnboardingSchema(env);
		ctx.assert.contains(onboardingMigration.migrated, "mise_onboarding_state", "migration creates state table");
		ctx.assert.contains(onboardingMigration.migrated, "mise_onboarding_responses", "migration creates responses table");
		ctx.assert.contains(onboardingMigration.migrated, "mise_household_traits", "migration creates traits table");
		ctx.assert.contains(onboardingMigration.migrated, "mise_household_traditions", "migration creates traditions table (Phase B placeholder)");
		ctx.assert.contains(onboardingMigration.altered, "dinner_ritual", "ALTER TABLE adds dinner_ritual column");
		ctx.assert.contains(onboardingMigration.altered, "cook_frequency", "ALTER TABLE adds cook_frequency column");
		ctx.assert.contains(onboardingMigration.altered, "pantry_intake_mode", "ALTER TABLE adds pantry_intake_mode column");

		// Re-running the migration must be a no-op (try/catch catches "duplicate column").
		const second = await migrateOnboardingSchema(env);
		ctx.assert.contains(second.migrated, "mise_onboarding_state", "second migration is idempotent");
		ctx.assert.eq(second.altered.length, 0, "second migration: no columns altered (already exist)");

		// 1. Start a fresh household.
		const start = await startOnboarding(env, { household_id: "hh_u85" });
		ctx.assert.eq(start.state.current_tier, 0, "fresh household starts at tier 0");
		ctx.assert.ok(!!start.next_question, "start returns a tier-0 question");
		ctx.assert.eq(start.next_question!.tier, 0, "first question is from tier 0");
		ctx.assert.eq(start.tier_progress[0], "in_progress", "tier 0 marked in_progress at start");
		ctx.assert.eq(start.tier_progress[1], "pending", "tier 1 marked pending");

		// 2. Walk every tier-0 question (required + optional) and answer.
		const tier0Required = TIER_0_QUESTIONS.filter(q => q.required);
		ctx.assert.gt(tier0Required.length, 0, "tier 0 has at least one required question");
		for (const q of TIER_0_QUESTIONS) {
			const sample = q.options ? q.options[0].value : "Cool Household";
			const result = await answerOnboarding(env, {
				household_id: "hh_u85",
				question_kind: q.kind,
				response_text: sample,
			});
			ctx.assert.eq(result.recorded, true, `recorded answer for ${q.kind}`);
		}

		// After all tier-0 answers, tier should advance to 1.
		const afterTier0 = await statusOnboarding(env, { household_id: "hh_u85" });
		ctx.assert.eq(afterTier0.state.current_tier, 1, "current_tier advanced to 1 after answering tier 0");
		ctx.assert.ok(!!afterTier0.state.tier_0_completed_at, "tier_0_completed_at stamped");
		ctx.assert.eq(afterTier0.state.tier_1_completed_at, null, "tier_1_completed_at not yet stamped");
		ctx.assert.ok(!!afterTier0.next_question, "next_question is now a tier-1 question");
		ctx.assert.eq(afterTier0.next_question!.tier, 1, "next_question tier is 1");

		// 3. Tier-1 dinner_ritual = 'table' should fire trait inference toward 0.0.
		const ritual = await answerOnboarding(env, {
			household_id: "hh_u85",
			question_kind: "tier_1_dinner_ritual",
			response_text: "table",
		});
		ctx.assert.gt(ritual.inferred_traits.length, 0, "dinner_ritual=table emits at least one trait delta");
		const ritualDelta = ritual.inferred_traits.find(t => t.trait_name === "ritual_vs_refueling");
		ctx.assert.ok(!!ritualDelta, "ritual_vs_refueling trait delta produced");
		ctx.assert.lte(ritualDelta!.new_value, 0.5, "ritual=table moves trait toward ritual end (≤0.5)");
		ctx.assert.gte(ritualDelta!.new_confidence, 0.2, "confidence rises by at least 0.2 after first delta");
		ctx.assert.lte(ritualDelta!.new_confidence, 0.3, "confidence stays under 0.3 after one piece of evidence (decay 0.7 × 0.3)");

		// Trait persisted and listable.
		const traits = await listTraits(env, "hh_u85");
		const persisted = traits.find(t => t.trait_name === "ritual_vs_refueling");
		ctx.assert.ok(!!persisted, "trait persisted in mise_household_traits");
		ctx.assert.eq(persisted!.evidence_count, 1, "evidence_count incremented to 1");
		ctx.assert.gt(persisted!.last_evidence_at_ms, 0, "last_evidence_at_ms set");

		// 4. Answer the rest of tier-1 required questions.
		await answerOnboarding(env, { household_id: "hh_u85", question_kind: "tier_1_avoidances", response_text: "shellfish allergy" });
		await answerOnboarding(env, { household_id: "hh_u85", question_kind: "tier_1_cook_frequency", response_text: "most" });
		await answerOnboarding(env, { household_id: "hh_u85", question_kind: "tier_1_pantry_intake", response_text: "gradual" });

		const afterTier1 = await statusOnboarding(env, { household_id: "hh_u85" });
		ctx.assert.eq(afterTier1.state.current_tier, 2, "current_tier advances to 2 after tier 1 required answered");
		ctx.assert.ok(!!afterTier1.state.tier_1_completed_at, "tier_1_completed_at stamped");

		// 5. Completion percentage is two of five tiers complete.
		ctx.assert.gte(afterTier1.completion_pct, 0.39, "completion_pct ≈ 0.4 (2 of 5 tiers)");
		ctx.assert.lte(afterTier1.completion_pct, 0.41, "completion_pct ≈ 0.4");

		// 6. Responses log is append-only and complete.
		const responses = await listResponses(env, "hh_u85");
		ctx.assert.eq(responses.length, TIER_0_QUESTIONS.length + 4, "every answer appended");
		const dinnerResponse = responses.find(r => r.question_kind === "tier_1_dinner_ritual");
		ctx.assert.ok(!!dinnerResponse, "dinner_ritual response logged");
		ctx.assert.eq(dinnerResponse!.response_text, "table", "stored answer round-trips");
		ctx.assert.gt(dinnerResponse!.response_chars, 0, "response_chars set for non-empty answer");
		ctx.assert.ok(!!dinnerResponse!.inferred_traits_json, "inferred_traits_json captured on the response row");

		// Sanity: status returns the same state back-to-back.
		const status2 = await statusOnboarding(env, { household_id: "hh_u85" });
		ctx.assert.eq(status2.state.current_tier, 2, "status is read-only — tier doesn't change");
		ctx.assert.eq(status2.state.questions_answered_count, afterTier1.state.questions_answered_count, "answered count stable across reads");

		ctx.notes.push(`u85 ritual_vs_refueling after one 'table' answer: value=${persisted!.trait_value}, conf=${persisted!.confidence}`);
		ctx.notes.push(`u85 completion_pct after tier 0+1: ${afterTier1.completion_pct}`);

		// 7. Cross-check: dinner_ritual mirror landed on the household profile.
		const profileRow = await env.DB.prepare(
			`SELECT dinner_ritual, cook_frequency, pantry_intake_mode FROM mise_household_profiles WHERE household_id = ?`,
		).bind("hh_u85").first<{ dinner_ritual: string | null; cook_frequency: string | null; pantry_intake_mode: string | null }>();
		ctx.assert.ok(!!profileRow, "household profile row created on first onboarding writeback");
		ctx.assert.eq(profileRow!.dinner_ritual, "table", "dinner_ritual mirrored to profile column");
		ctx.assert.eq(profileRow!.cook_frequency, "most", "cook_frequency mirrored to profile column");
		ctx.assert.eq(profileRow!.pantry_intake_mode, "gradual", "pantry_intake_mode mirrored to profile column");

		// Don't leak isolation between households.
		const fresh = await startOnboarding(env, { household_id: "hh_u85_fresh" });
		ctx.assert.eq(fresh.state.current_tier, 0, "second household starts independently at tier 0");

		// Skip-only path also touches the helper but doesn't leak deltas.
		const skipResult = await skipOnboarding(env, { household_id: "hh_u85_fresh", question_kind: "tier_0_household_name" });
		ctx.assert.eq(skipResult.recorded, true, "skip recorded on fresh household");
		ctx.assert.eq(skipResult.inferred_traits.length, 0, "skip never emits trait deltas");
	},
};

export default u85;
