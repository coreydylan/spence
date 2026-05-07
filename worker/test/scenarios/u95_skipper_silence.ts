// U95 — Skipper detection puts the scheduler in silence mode.
//
// Confirms:
//   * detectSkipper requires ≥10 history rows before classifying anyone as
//     a skipper — no premature silencing.
//   * 10 rows with ≥80% skipped (≤2 answered) flips is_skipper=true.
//   * pickQuestionForBrief returns null for a skipper regardless of how
//     juicy the unmet question bag is.
//   * As soon as response_rate climbs back above 0.2 the scheduler resumes.

import type { Scenario } from "../lib/types";
import {
	detectSkipper,
	pickQuestionForBrief,
	SKIPPER_RATE,
	SKIPPER_WINDOW,
} from "../../src/mise-graph/onboarding-scheduler";
import { allQuestions } from "../../src/mise-graph/onboarding-questions";
import type { OnboardingState, ResponseRow } from "../../src/mise-graph/onboarding";

function row(opts: { kind: string; answered: boolean; ms: number }): ResponseRow {
	return {
		response_id: `r_${opts.kind}_${opts.ms}`,
		household_id: "hh_u95",
		member_id: null,
		question_kind: opts.kind,
		question_text: "?",
		response_text: opts.answered ? "ok" : null,
		response_chars: opts.answered ? 2 : 0,
		asked_at_ms: opts.ms,
		answered_at_ms: opts.answered ? opts.ms : null,
		inferred_traits_json: null,
		tier: 1,
	};
}

const u95: Scenario = {
	id: "u95",
	name: "Skipper detection silences the scheduler until engagement returns",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const now = Date.UTC(2026, 4, 7, 14, 0, 0);
		const state: OnboardingState = {
			household_id: "hh_u95",
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
		const dayMs = 24 * 60 * 60 * 1000;

		// 1. Less than SKIPPER_WINDOW history → cannot be a skipper yet, even
		//    if every recorded question was skipped.
		const fewSkips: ResponseRow[] = [];
		for (let i = 0; i < SKIPPER_WINDOW - 2; i++) {
			fewSkips.push(row({ kind: `q_few_${i}`, answered: false, ms: now - (i + 5) * dayMs }));
		}
		const earlyDetect = detectSkipper(fewSkips);
		ctx.assert.eq(earlyDetect.is_skipper, false, "skipper requires ≥10 history rows; 8 skips not enough");

		// 2. 10 rows with 8 skips + 2 answers → response_rate=0.2, NOT below
		//    0.2 threshold. Confirm the boundary is strict-less-than.
		const boundary: ResponseRow[] = [];
		for (let i = 0; i < SKIPPER_WINDOW; i++) {
			boundary.push(row({ kind: `b_${i}`, answered: i < 2, ms: now - (i + 5) * dayMs }));
		}
		const boundaryDetect = detectSkipper(boundary);
		ctx.assert.eq(boundaryDetect.response_rate, 0.2, "boundary case has rate=0.2");
		ctx.assert.eq(boundaryDetect.is_skipper, false, "boundary at exactly 0.2 is NOT a skipper (strict-less-than)");

		// 3. 10 rows with 1 answer + 9 skips → response_rate=0.1, IS a skipper.
		const skipperHistory: ResponseRow[] = [];
		for (let i = 0; i < SKIPPER_WINDOW; i++) {
			skipperHistory.push(row({ kind: `s_${i}`, answered: i === 0, ms: now - (i + 5) * dayMs }));
		}
		const skipperDetect = detectSkipper(skipperHistory);
		ctx.assert.ok(skipperDetect.response_rate < SKIPPER_RATE, "skipper rate < 0.2");
		ctx.assert.eq(skipperDetect.is_skipper, true, "9-of-10 skips marks user as skipper");

		// 4. pickQuestionForBrief returns null for a skipper even though the
		//    full bank is "available" (we want a fresh hook before re-engaging).
		const silenced = pickQuestionForBrief({
			state,
			recent_responses: skipperHistory,
			available_questions: allQuestions(),
			now_ms: now,
			engagement_signal: 1.0,
		});
		ctx.assert.eq(silenced, null, "skipper short-circuits picker to null");

		// 5. Once engagement returns (rate climbs above 0.2), scheduler resumes.
		const recovered: ResponseRow[] = [];
		for (let i = 0; i < SKIPPER_WINDOW; i++) {
			recovered.push(row({ kind: `r_${i}`, answered: i < 5, ms: now - (i + 5) * dayMs }));
		}
		const recoveredDetect = detectSkipper(recovered);
		ctx.assert.eq(recoveredDetect.is_skipper, false, "recovered user no longer flagged as skipper");

		const recoveredPick = pickQuestionForBrief({
			state,
			recent_responses: recovered,
			available_questions: allQuestions(),
			now_ms: now,
			engagement_signal: 1.0,
		});
		ctx.assert.ok(!!recoveredPick, "scheduler resumes for recovered user");

		ctx.notes.push(`u95 skipper rate=${skipperDetect.response_rate}, recovered rate=${recoveredDetect.response_rate}`);
	},
};

export default u95;
