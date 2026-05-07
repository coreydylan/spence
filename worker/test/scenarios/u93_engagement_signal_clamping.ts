// U93 — Engagement signal computation + clamping behavior.
//
// Confirms:
//   * Empty history yields the neutral 1.0 signal.
//   * A chatty user (long answers, high response rate) clamps at 2.0.
//   * A terse user (short answers, low response rate) clamps at 0.5.
//   * Cooldown decay damps the signal when we just asked something.
//   * Terse engagement raises the score threshold (TERSE_SCORE_THRESHOLD)
//     so a marginal question gets suppressed.

import type { Scenario } from "../lib/types";
import {
	computeEngagementSignal,
	pickQuestionForBrief,
	ENGAGEMENT_CHATTY,
	ENGAGEMENT_TERSE,
	TERSE_SCORE_THRESHOLD,
} from "../../src/mise-graph/onboarding-scheduler";
import {
	allQuestions,
	TIER_1_QUESTIONS,
} from "../../src/mise-graph/onboarding-questions";
import type { OnboardingState, ResponseRow } from "../../src/mise-graph/onboarding";

const u93: Scenario = {
	id: "u93",
	name: "Engagement signal computation + threshold gating",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const now = Date.UTC(2026, 4, 7, 14, 0, 0);

		// 1. Empty history → neutral 1.0.
		const empty = computeEngagementSignal([], now);
		ctx.assert.eq(empty, 1.0, "empty history yields neutral 1.0 signal");

		// 2. Chatty user: long answers (200 chars avg), high rate, asked > 24h ago.
		const chattyHistory: ResponseRow[] = [];
		for (let i = 0; i < 10; i++) {
			chattyHistory.push({
				response_id: `c${i}`,
				household_id: "hh_u93_chatty",
				member_id: null,
				question_kind: `q_${i}`,
				question_text: "?",
				response_text: "x".repeat(220),
				response_chars: 220,
				asked_at_ms: now - (i + 2) * 24 * 60 * 60 * 1000, // > 24h ago
				answered_at_ms: now - (i + 2) * 24 * 60 * 60 * 1000,
				inferred_traits_json: null,
				tier: 1,
			});
		}
		const chattySignal = computeEngagementSignal(chattyHistory, now);
		ctx.assert.lte(chattySignal, 2.0, "chatty signal clamps at 2.0 ceiling");
		ctx.assert.gte(chattySignal, ENGAGEMENT_CHATTY, "chatty signal exceeds chatty threshold (1.4)");

		// 3. Terse user: very short answers + low response rate.
		const terseHistory: ResponseRow[] = [];
		for (let i = 0; i < 10; i++) {
			const answered = i < 2; // 20% rate (right at the skipper edge — bump to be safe)
			terseHistory.push({
				response_id: `t${i}`,
				household_id: "hh_u93_terse",
				member_id: null,
				question_kind: `q_${i}`,
				question_text: "?",
				response_text: answered ? "ok" : null,
				response_chars: answered ? 2 : 0,
				asked_at_ms: now - (i + 2) * 24 * 60 * 60 * 1000,
				answered_at_ms: answered ? now - (i + 2) * 24 * 60 * 60 * 1000 : null,
				inferred_traits_json: null,
				tier: 1,
			});
		}
		const terseSignal = computeEngagementSignal(terseHistory, now);
		ctx.assert.gte(terseSignal, 0.5, "terse signal clamps at 0.5 floor");
		ctx.assert.ok(terseSignal < ENGAGEMENT_TERSE, "terse signal stays below terse threshold (0.7)");

		// 4. Cooldown decay: a mid-engagement user (neither at floor nor at
		//    ceiling) gets damped when the most recent ask was 1h ago vs >24h.
		//    avg_chars=60, rate=0.7 → raw=1.0 (mid-range, easy to observe damp).
		const baseHistory: ResponseRow[] = [];
		for (let i = 0; i < 10; i++) {
			const answered = i < 7;
			baseHistory.push({
				response_id: `m${i}`,
				household_id: "hh_u93_mid",
				member_id: null,
				question_kind: `q_${i}`,
				question_text: "?",
				response_text: answered ? "x".repeat(60) : null,
				response_chars: answered ? 60 : 0,
				asked_at_ms: now - (i + 2) * 24 * 60 * 60 * 1000, // > 24h ago for all
				answered_at_ms: answered ? now - (i + 2) * 24 * 60 * 60 * 1000 : null,
				inferred_traits_json: null,
				tier: 1,
			});
		}
		const baseSignal = computeEngagementSignal(baseHistory, now);
		const recentAskHistory = baseHistory.map((r, i) =>
			i === 0 ? { ...r, asked_at_ms: now - 60 * 60 * 1000, answered_at_ms: r.answered_at_ms !== null ? now - 60 * 60 * 1000 : null } : r,
		);
		const damped = computeEngagementSignal(recentAskHistory, now);
		ctx.assert.ok(damped < baseSignal, "cooldown decay damps the signal vs same content asked > 24h ago");

		// 5. Threshold gating — terse user with a low-tier-only candidate set.
		//    A tier-1 personality question (low priority) should be suppressed
		//    when engagement is terse (raised threshold = 0.6).
		const state: OnboardingState = {
			household_id: "hh_u93",
			current_tier: 1,
			tier_0_completed_at: new Date(now - 1000).toISOString(),
			tier_1_completed_at: null,
			tier_2_completed_at: null,
			tier_3_completed_at: null,
			active_question_bag_json: null,
			engagement_signal: terseSignal,
			last_question_asked_at: null,
			questions_asked_count: 0,
			questions_answered_count: 0,
			questions_skipped_count: 0,
			updated_at_ms: now,
		};
		// Restrict candidates to a single tier-1 personality question that
		// will score below 0.6 once tier-priority + personality kind apply.
		const ritualOnly = [TIER_1_QUESTIONS.find(q => q.kind === "tier_1_dinner_ritual")!];
		const tersePick = pickQuestionForBrief({
			state,
			recent_responses: [],
			available_questions: ritualOnly,
			now_ms: now,
			engagement_signal: 0.5, // hard-floor terse for deterministic threshold check
		});
		// tier1 (0.8) × personality (0.7) × novelty (1.0) × hook (1.0) = 0.56 × 0.5 = 0.28 < 0.6
		ctx.assert.eq(tersePick, null, "terse threshold suppresses a marginal tier-1 personality question");

		// Same single candidate, default engagement → score 0.56 > 0.3, so picker returns it.
		const defaultPick = pickQuestionForBrief({
			state,
			recent_responses: [],
			available_questions: ritualOnly,
			now_ms: now,
			engagement_signal: 1.0,
		});
		ctx.assert.ok(!!defaultPick, "default engagement still surfaces the same question");

		ctx.notes.push(`u93 chatty=${chattySignal.toFixed(2)} damped=${damped.toFixed(2)} terse=${terseSignal.toFixed(2)}`);
		ctx.notes.push(`u93 terse threshold = ${TERSE_SCORE_THRESHOLD}, default = 0.3`);
		// allQuestions() referenced for completeness — verifies bank import.
		ctx.assert.gt(allQuestions().length, 0, "question bank is non-empty (sanity)");
	},
};

export default u93;
