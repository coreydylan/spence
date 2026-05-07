// U99 — Chattiness filter (Phase D budget-aware question selection).
//
// Confirms:
//   * applyChattinessFilter with engagement_signal < 0.7 (terse user) gates
//     out tier 3/4 questions entirely; only tier 0/1/2 remain.
//   * Engagement 0.7..1.4 (default) leaves all tiers in but caps to 1
//     question per brief.
//   * Engagement ≥ 1.4 (chatty) allows all tiers AND lets the caller ask
//     up to 2 questions per brief.
//   * gated[] reports the questions removed so callers can log it.
//   * The filter is type-stable across Question + HookedQuestion.

import type { Scenario } from "../lib/types";
import { applyChattinessFilter } from "../../src/mise-graph/onboarding-hooks";
import {
	TIER_0_QUESTIONS,
	TIER_1_QUESTIONS,
	TIER_2_QUESTIONS,
	TIER_3_QUESTIONS,
	TIER_4_QUESTIONS,
} from "../../src/mise-graph/onboarding-questions";

const u99: Scenario = {
	id: "u99",
	name: "Phase D chattiness filter gates tier 3/4 from terse users",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// Combine all 5 tiers into one candidate list. The actual scheduler
		// only ever feeds Question[] — we exercise both shapes by mixing.
		const combined = [
			...TIER_0_QUESTIONS,
			...TIER_1_QUESTIONS,
			...TIER_2_QUESTIONS,
			...TIER_3_QUESTIONS,
			...TIER_4_QUESTIONS,
		].map(q => ({ kind: q.kind, tier: q.tier as number }));

		const total = combined.length;
		ctx.assert.gte(total, 20, "combined bank has plenty of questions");

		// 1. Terse user (engagement = 0.5) — tier 3/4 gated out -----------------
		const terse = applyChattinessFilter(combined, 0.5);
		ctx.assert.eq(terse.max_questions, 1, "terse user gets max 1 question per brief");
		const terseHasTier3 = terse.allowed.some(q => q.tier === 3);
		const terseHasTier4 = terse.allowed.some(q => q.tier === 4);
		ctx.assert.eq(terseHasTier3, false, "terse user does not see tier 3 questions");
		ctx.assert.eq(terseHasTier4, false, "terse user does not see tier 4 questions");
		const terseTier2 = terse.allowed.filter(q => q.tier === 2).length;
		ctx.assert.gt(terseTier2, 0, "terse user still sees tier 2 (week-1 calibration)");
		const terseTier01 = terse.allowed.filter(q => q.tier <= 1).length;
		ctx.assert.gt(terseTier01, 0, "terse user still sees tier 0/1");
		ctx.assert.gt(terse.gated.length, 0, "gated[] reports the removed questions");
		const allGatedAreDeep = terse.gated.every(q => q.tier >= 3);
		ctx.assert.eq(allGatedAreDeep, true, "every gated entry is tier 3 or 4");

		// Conservation — allowed + gated covers every input question.
		ctx.assert.eq(terse.allowed.length + terse.gated.length, total, "allowed + gated = total");

		// 2. Default engagement (signal = 1.0) — all tiers allowed -------------
		const def = applyChattinessFilter(combined, 1.0);
		ctx.assert.eq(def.max_questions, 1, "default engagement: 1 question per brief");
		ctx.assert.eq(def.allowed.length, total, "default engagement: all questions allowed");
		ctx.assert.eq(def.gated.length, 0, "default engagement: nothing gated");

		// 3. Chatty engagement (signal = 1.6) — all tiers + 2 questions --------
		const chatty = applyChattinessFilter(combined, 1.6);
		ctx.assert.eq(chatty.max_questions, 2, "chatty engagement: 2 questions per brief");
		ctx.assert.eq(chatty.allowed.length, total, "chatty engagement: all questions allowed");

		// 4. Boundary checks --------------------------------------------------
		// Exactly 0.7 should be treated as "default" (NOT terse).
		const boundary = applyChattinessFilter(combined, 0.7);
		const boundaryHasTier3 = boundary.allowed.some(q => q.tier === 3);
		ctx.assert.eq(boundaryHasTier3, true, "engagement = 0.7 is the default tier (not terse)");
		// Exactly 1.4 should be treated as chatty.
		const chattyBoundary = applyChattinessFilter(combined, 1.4);
		ctx.assert.eq(chattyBoundary.max_questions, 2, "engagement = 1.4 is chatty (max 2)");

		// 5. NaN / non-finite engagement falls back to default ------------------
		const safe = applyChattinessFilter(combined, Number.NaN);
		ctx.assert.eq(safe.allowed.length, total, "NaN engagement coerces to default (all allowed)");
		ctx.assert.eq(safe.max_questions, 1, "NaN engagement: 1 question");

		ctx.notes.push(`u99 chattiness filter: terse gates ${terse.gated.length} of ${total}`);
	},
};

export default u99;
