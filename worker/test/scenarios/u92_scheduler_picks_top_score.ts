// U92 — Daily question scheduler scoring + top-pick selection.
//
// Confirms:
//   * pickQuestionForBrief picks the highest-scoring question among the
//     candidates (tier 0 with novelty=1 outranks tier 1 + tier 4).
//   * Already-answered questions are excluded.
//   * Recently-asked-but-not-answered questions get a low novelty_decay.
//   * If we mock all candidates as "just asked" (novelty ≈ 0), the picker
//     returns null instead of resurfacing the same question.

import type { Scenario } from "../lib/types";
import {
	pickQuestionForBrief,
	scoreQuestion,
} from "../../src/mise-graph/onboarding-scheduler";
import {
	TIER_0_QUESTIONS,
	TIER_1_QUESTIONS,
	allQuestions,
	type Question,
} from "../../src/mise-graph/onboarding-questions";
import type { OnboardingState, ResponseRow } from "../../src/mise-graph/onboarding";

const u92: Scenario = {
	id: "u92",
	name: "Daily scheduler picks the highest-scoring question",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const now = Date.UTC(2026, 4, 7, 14, 0, 0); // brief time
		const state: OnboardingState = {
			household_id: "hh_u92",
			current_tier: 0,
			tier_0_completed_at: null,
			tier_1_completed_at: null,
			tier_2_completed_at: null,
			tier_3_completed_at: null,
			active_question_bag_json: null,
			engagement_signal: 1.0,
			last_question_asked_at: null,
			questions_asked_count: 0,
			questions_answered_count: 0,
			questions_skipped_count: 0,
			updated_at_ms: now,
		};

		// 1. With NO history and full bank, the picker should return the
		//    highest-priority question. Tier-1 dietary (avoidances) at
		//    0.8 × 1.2 = 0.96 outranks tier-0 personality at 1.0 × 0.7 = 0.70.
		const fresh = pickQuestionForBrief({
			state,
			recent_responses: [],
			available_questions: allQuestions(),
			now_ms: now,
			engagement_signal: 1.0,
		});
		ctx.assert.ok(!!fresh, "picker returns a question for a fresh household");
		ctx.assert.eq(fresh!.question.kind, "tier_1_avoidances", "dietary kind × tier-1 outranks tier-0 personality");
		ctx.assert.gt(fresh!.score, 0.3, "score exceeds the default 0.3 threshold");

		// Tier-0-only filter should still surface a tier-0 question — proves
		// the scheduler isn't broken for bank subsets.
		const tier0only = pickQuestionForBrief({
			state,
			recent_responses: [],
			available_questions: TIER_0_QUESTIONS,
			now_ms: now,
			engagement_signal: 1.0,
		});
		ctx.assert.ok(!!tier0only, "picker returns a tier-0 question when bank is tier-0 only");
		ctx.assert.eq(tier0only!.question.tier, 0, "tier-0 bank yields tier-0 pick");

		// 2. Score breakdown is sensible: tier 0 + dietary kind (avoidances) >
		//    tier 1 + dietary, > tier 1 + personality.
		const tier1Avoidances = TIER_1_QUESTIONS.find(q => q.kind === "tier_1_avoidances")!;
		const tier1Ritual = TIER_1_QUESTIONS.find(q => q.kind === "tier_1_dinner_ritual")!;
		const breakdownAv = scoreQuestion(tier1Avoidances, { last_asked_at_ms: null, now_ms: now });
		const breakdownRit = scoreQuestion(tier1Ritual, { last_asked_at_ms: null, now_ms: now });
		ctx.assert.gt(breakdownAv.score, breakdownRit.score, "tier-1 avoidances (dietary) outranks tier-1 dinner_ritual (personality)");

		// 3. If every tier-0 question has been ANSWERED, the picker should fall
		//    through to tier-1.
		const answeredTier0: ResponseRow[] = TIER_0_QUESTIONS.map((q, i) => ({
			response_id: `r${i}`,
			household_id: "hh_u92",
			member_id: null,
			question_kind: q.kind,
			question_text: q.question_text,
			response_text: q.options ? q.options[0].value : "ok",
			response_chars: 4,
			asked_at_ms: now - 7 * 24 * 60 * 60 * 1000,
			answered_at_ms: now - 7 * 24 * 60 * 60 * 1000,
			inferred_traits_json: null,
			tier: 0,
		}));
		const afterTier0 = pickQuestionForBrief({
			state: { ...state, current_tier: 1 },
			recent_responses: answeredTier0,
			available_questions: allQuestions(),
			now_ms: now,
			engagement_signal: 1.0,
		});
		ctx.assert.ok(!!afterTier0, "picker still returns a question once tier-0 is answered");
		ctx.assert.eq(afterTier0!.question.tier, 1, "next-best is a tier-1 question");

		// 4. Recently-asked-but-unanswered questions are suppressed by the 24h
		//    cooldown — picker should fall through to a different one.
		const justAskedKind = TIER_0_QUESTIONS[0].kind;
		const askedTwoHoursAgo: ResponseRow[] = [{
			response_id: "rA",
			household_id: "hh_u92",
			member_id: null,
			question_kind: justAskedKind,
			question_text: TIER_0_QUESTIONS[0].question_text,
			response_text: null,                   // skipped, not answered
			response_chars: 0,
			asked_at_ms: now - 2 * 60 * 60 * 1000, // 2h ago < 24h cooldown
			answered_at_ms: null,
			inferred_traits_json: null,
			tier: 0,
		}];
		const cooled = pickQuestionForBrief({
			state,
			recent_responses: askedTwoHoursAgo,
			available_questions: allQuestions(),
			now_ms: now,
			engagement_signal: 1.0,
		});
		ctx.assert.ok(!!cooled, "picker returns a different question during cooldown");
		ctx.assert.notEq(cooled!.question.kind, justAskedKind, "the recently-asked kind is suppressed");

		// 5. If EVERY candidate was just asked, picker returns null (silence).
		const allJustAsked: ResponseRow[] = allQuestions().map((q, i) => ({
			response_id: `j${i}`,
			household_id: "hh_u92",
			member_id: null,
			question_kind: q.kind,
			question_text: q.question_text,
			response_text: null,                   // all skipped within cooldown
			response_chars: 0,
			asked_at_ms: now - 60 * 60 * 1000,     // 1h ago
			answered_at_ms: null,
			inferred_traits_json: null,
			tier: q.tier,
		}));
		const silent = pickQuestionForBrief({
			state,
			recent_responses: allJustAsked,
			available_questions: allQuestions(),
			now_ms: now,
			engagement_signal: 1.0,
		});
		ctx.assert.eq(silent, null, "picker stays silent when every question is in cooldown");

		// 6. Hook-match bonus: a question whose text contains a recent-activity
		//    token gets the 1.5× boost over an otherwise-equivalent peer.
		const fakeQuestionPlain: Question = {
			kind: "tier_0_household_name",            // reuse a real kind shape
			tier: 1,
			required: false,
			question_text: "Tell me about your week.",
			free_text_allowed: true,
		};
		const fakeQuestionHooked: Question = {
			...fakeQuestionPlain,
			kind: "tier_0_size",
			question_text: "I noticed tofu showed up a lot — anchor or phase?",
		};
		const plain = scoreQuestion(fakeQuestionPlain, { last_asked_at_ms: null, now_ms: now });
		const hooked = scoreQuestion(fakeQuestionHooked, { last_asked_at_ms: null, now_ms: now, recent_activity_tokens: ["tofu"] });
		ctx.assert.gt(hooked.hook_match_bonus, plain.hook_match_bonus, "hook_match_bonus elevates a hot-token question");
		ctx.assert.gt(hooked.score, plain.score, "hot-token question scores higher overall");

		ctx.notes.push(`u92 fresh pick: ${fresh!.question.kind} score=${fresh!.score}`);
		ctx.notes.push(`u92 hook bonus delta: ${(hooked.score - plain.score).toFixed(3)}`);
	},
};

export default u92;
