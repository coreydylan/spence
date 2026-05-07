// Onboarding Phase C — Daily question scheduler.
//
// Pure functions for picking the highest-scoring question for the morning
// brief, plus the engagement-signal computation that drives chattiness
// adaptation.
//
// Inputs come in as plain rows (state, recent responses, available
// questions) — no I/O — so the caller can dependency-inject the question
// bank and we stay easy to unit-test. The actual brief integration in
// household-cycles.ts wires the DB reads.
//
// Scoring spec from ONBOARDING_DESIGN.md:
//   score = tier_weight[q.tier]
//         × hook_match_bonus
//         × novelty_decay(q, last_asked)
//         × question_kind_priority
//         × engagement_signal
// Threshold: if score < 0.3 for all candidates, return null (skip morning).
//
// Engagement signal:
//   chatty   ≥1.4  pick top scorer regardless
//   default  0.7-1.4 pick top scorer
//   terse    <0.7  only pick if score ≥ 0.6
//   skipper  response_rate <0.2 over last 10  return null (silence 4 wk)

import type { OnboardingState, ResponseRow } from "./onboarding";
import type { Question, QuestionKind, TraitName } from "./onboarding-questions";

// ─── Public types ───────────────────────────────────────────────────────────

export interface ScheduledQuestion {
	question: Question;
	score: number;
	reason: string;
}

export interface PickQuestionInput {
	state: OnboardingState;
	recent_responses: ResponseRow[];
	available_questions: ReadonlyArray<Question>;
	now_ms: number;
	engagement_signal: number;
	/**
	 * Optional set of "hot" tokens — recent activity hints (ingredients,
	 * cuisines, formats from the last few meal events). Used to apply the
	 * 1.5× hook_match_bonus when a question text contains one of these
	 * tokens. Pass an empty array if no hint data is available.
	 */
	recent_activity_tokens?: ReadonlyArray<string>;
}

// ─── Constants ──────────────────────────────────────────────────────────────

export const SCORE_THRESHOLD = 0.3;
export const TERSE_SCORE_THRESHOLD = 0.6;
export const ENGAGEMENT_CHATTY = 1.4;
export const ENGAGEMENT_TERSE = 0.7;
export const SKIPPER_RATE = 0.2;
export const SKIPPER_WINDOW = 10;
export const HOOK_MATCH_BONUS = 1.5;
export const NOVELTY_HALFLIFE_DAYS = 7;

const TIER_WEIGHT: Readonly<Record<number, number>> = {
	0: 1.0,
	1: 0.8,
	2: 0.5,
	3: 0.3,
	4: 0.4,
};

// We classify each question by the trait dimension(s) it targets to apply
// kind_priority. The dietary/equipment categorizations come from the
// question kind prefix; tradition/personality come from the inferred-trait
// targets. Anything without a trait rule is treated as "personality"
// (lowest-priority) so we don't accidentally over-weight novel tier-2/3
// questions whose deltas haven't been declared yet.
const KIND_PRIORITY = {
	dietary: 1.2,
	equipment: 1.0,
	tradition: 0.9,
	personality: 0.7,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Engagement signal ──────────────────────────────────────────────────────

/**
 * Compute engagement_signal from recent response history.
 *
 *   signal = clamp(0.5..2.0, (avg_chars / 60) × (rate / 0.7) × cooldown_decay)
 *
 * - avg_chars is the mean of `response_chars` over the last 5 ANSWERED
 *   responses (skips don't count toward chattiness — they pull rate down
 *   instead).
 * - rate is fraction of the last 10 surfaced questions that received a
 *   non-null response_text.
 * - cooldown_decay damps the signal when we asked very recently:
 *     1.0 if last_asked > 24h ago, ramping linearly to 0.6 if asked in
 *     the last hour. Prevents back-to-back chatty bursts from compounding.
 */
export function computeEngagementSignal(
	recent_responses: ReadonlyArray<ResponseRow>,
	now_ms: number,
): number {
	if (!Array.isArray(recent_responses) || recent_responses.length === 0) {
		// No history → neutral default. Caller treats this as "default" tier.
		return 1.0;
	}

	// Sort newest-first defensively (callers should already, but cheap).
	const sorted = recent_responses
		.slice()
		.sort((a, b) => (b.asked_at_ms || 0) - (a.asked_at_ms || 0));

	// avg_chars over last 5 answered (skip nulls).
	const lastFiveAnswered = sorted
		.filter(r => typeof r.response_text === "string" && r.response_text.length > 0)
		.slice(0, 5);
	const avgChars = lastFiveAnswered.length === 0
		? 0
		: lastFiveAnswered.reduce((acc, r) => acc + (r.response_chars || 0), 0) / lastFiveAnswered.length;

	// rate over last 10.
	const lastTen = sorted.slice(0, 10);
	const answeredCount = lastTen.filter(r =>
		typeof r.response_text === "string" && r.response_text.length > 0,
	).length;
	const rate = lastTen.length === 0 ? 0 : answeredCount / lastTen.length;

	// cooldown decay: how recently did we ASK something at all?
	const mostRecentAskMs = sorted[0]?.asked_at_ms || 0;
	const hoursSinceLastAsk = mostRecentAskMs > 0
		? Math.max(0, (now_ms - mostRecentAskMs) / (60 * 60 * 1000))
		: Number.POSITIVE_INFINITY;
	let cooldownDecay = 1.0;
	if (Number.isFinite(hoursSinceLastAsk) && hoursSinceLastAsk < 24) {
		// Linear ramp from 0.6 (just asked) to 1.0 (24h ago).
		cooldownDecay = 0.6 + 0.4 * (hoursSinceLastAsk / 24);
	}

	const charsTerm = avgChars / 60;
	const rateTerm = rate / 0.7;
	const raw = charsTerm * rateTerm * cooldownDecay;
	return clamp(raw, 0.5, 2.0);
}

// ─── Skipper detection ──────────────────────────────────────────────────────

export interface SkipperState {
	is_skipper: boolean;
	response_rate: number;
	considered: number;
}

/**
 * "Skipper" if response_rate < 0.2 across the last 10 surfaced questions.
 * If we don't yet have 10 history points the user can't be a skipper —
 * we need real evidence before we go silent for 4 weeks.
 */
export function detectSkipper(recent_responses: ReadonlyArray<ResponseRow>): SkipperState {
	if (!Array.isArray(recent_responses) || recent_responses.length < SKIPPER_WINDOW) {
		return { is_skipper: false, response_rate: 1.0, considered: recent_responses?.length ?? 0 };
	}
	const sorted = recent_responses
		.slice()
		.sort((a, b) => (b.asked_at_ms || 0) - (a.asked_at_ms || 0))
		.slice(0, SKIPPER_WINDOW);
	const answered = sorted.filter(r =>
		typeof r.response_text === "string" && r.response_text.length > 0,
	).length;
	const rate = answered / sorted.length;
	return { is_skipper: rate < SKIPPER_RATE, response_rate: rate, considered: sorted.length };
}

// ─── Scoring ────────────────────────────────────────────────────────────────

export interface ScoringBreakdown {
	tier_weight: number;
	kind_priority: number;
	novelty_decay: number;
	hook_match_bonus: number;
	engagement_signal: number;
	score: number;
	reason: string;
}

/**
 * Score a single question without engagement. Useful for tests and for
 * UI surfaces that want to show "why this question scored high."
 */
export function scoreQuestion(
	question: Question,
	context: {
		last_asked_at_ms: number | null;
		now_ms: number;
		recent_activity_tokens?: ReadonlyArray<string>;
	},
): ScoringBreakdown {
	const tier_weight = TIER_WEIGHT[question.tier] ?? 0.4;
	const kind_priority = kindPriorityFor(question);
	const novelty_decay = noveltyDecay(context.last_asked_at_ms, context.now_ms);
	const hook_match_bonus = hookMatchBonus(question, context.recent_activity_tokens || []);

	const score = tier_weight * kind_priority * novelty_decay * hook_match_bonus;

	const parts: string[] = [
		`tier${question.tier}=${tier_weight.toFixed(2)}`,
		`kind=${kindLabelFor(question)}=${kind_priority.toFixed(2)}`,
		`novelty=${novelty_decay.toFixed(2)}`,
	];
	if (hook_match_bonus > 1) parts.push(`hook×${hook_match_bonus.toFixed(2)}`);

	return {
		tier_weight,
		kind_priority,
		novelty_decay,
		hook_match_bonus,
		engagement_signal: 1.0,
		score: round3(score),
		reason: parts.join(" "),
	};
}

/**
 * Pick the highest-scoring question for today's brief, applying engagement
 * gating and the skipper short-circuit. Returns null when nothing should be
 * surfaced this morning.
 */
export function pickQuestionForBrief(input: PickQuestionInput): ScheduledQuestion | null {
	const {
		state,
		recent_responses,
		available_questions,
		now_ms,
		engagement_signal,
		recent_activity_tokens,
	} = input;

	// Skipper: the household has refused to engage for 4+ weeks. Stay silent.
	const skipper = detectSkipper(recent_responses);
	if (skipper.is_skipper) {
		// Caller may inspect by calling detectSkipper themselves; here we just
		// short-circuit. Spec says "go silent 4 weeks then re-try with a fresh
		// hook" — re-try logic is Phase D.
		return null;
	}

	if (!Array.isArray(available_questions) || available_questions.length === 0) {
		return null;
	}

	// Build a per-kind last-asked-at index from the response log.
	const lastAskedByKind = new Map<string, number>();
	const askCountByKind = new Map<string, number>();
	for (const r of recent_responses) {
		if (!r || typeof r.question_kind !== "string") continue;
		const prev = lastAskedByKind.get(r.question_kind) ?? 0;
		if ((r.asked_at_ms || 0) > prev) lastAskedByKind.set(r.question_kind, r.asked_at_ms);
		askCountByKind.set(r.question_kind, (askCountByKind.get(r.question_kind) ?? 0) + 1);
	}

	// Track which kinds the household has *answered* (response_text non-null) —
	// answered questions never resurface. Skipped ones can be re-asked later.
	const answeredKinds = new Set<string>();
	for (const r of recent_responses) {
		if (!r) continue;
		if (typeof r.response_text === "string" && r.response_text.length > 0) {
			answeredKinds.add(r.question_kind);
		}
	}

	// Don't ask the same question twice in 24h regardless of answer state.
	const ASK_COOLDOWN_MS = DAY_MS;

	let best: { q: Question; score: number; breakdown: ScoringBreakdown } | null = null;
	for (const q of available_questions) {
		if (answeredKinds.has(q.kind)) continue;
		const lastAt = lastAskedByKind.get(q.kind) ?? null;
		if (lastAt !== null && now_ms - lastAt < ASK_COOLDOWN_MS) continue;

		const breakdown = scoreQuestion(q, {
			last_asked_at_ms: lastAt,
			now_ms,
			recent_activity_tokens,
		});
		const final = breakdown.score * engagement_signal;
		if (!best || final > best.score) {
			best = { q, score: final, breakdown };
		}
	}

	if (!best) return null;

	// Engagement-tier gating:
	//   chatty (≥1.4) → always pick the top scorer
	//   default (0.7-1.4) → pick top scorer if above threshold
	//   terse (<0.7) → require raised threshold
	const threshold = engagement_signal < ENGAGEMENT_TERSE
		? TERSE_SCORE_THRESHOLD
		: SCORE_THRESHOLD;

	if (engagement_signal >= ENGAGEMENT_CHATTY) {
		// Chatty users get the top-scorer regardless.
	} else if (best.score < threshold) {
		return null;
	}

	// Suppress useless asks even for chatty users — if every contributor is
	// near zero (e.g. all questions just asked) respect the floor.
	if (best.score <= 0) return null;

	// State is informational here (last_question_asked_at not consulted
	// directly) — but we keep the signature for forward compat.
	void state;

	return {
		question: best.q,
		score: round3(best.score),
		reason: `${best.breakdown.reason} engagement=${engagement_signal.toFixed(2)} → ${round3(best.score)}`,
	};
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function noveltyDecay(last_asked_at_ms: number | null, now_ms: number): number {
	if (last_asked_at_ms === null || last_asked_at_ms <= 0) return 1.0;
	const days = Math.max(0, (now_ms - last_asked_at_ms) / DAY_MS);
	// Spec: 1 - exp(-days/7). At days=0 → 0; at days=7 → ~0.63; at days=14 → ~0.86.
	const decay = 1 - Math.exp(-days / NOVELTY_HALFLIFE_DAYS);
	return clamp(decay, 0, 1);
}

function hookMatchBonus(
	question: Question,
	recent_activity_tokens: ReadonlyArray<string>,
): number {
	if (!recent_activity_tokens || recent_activity_tokens.length === 0) return 1.0;
	const haystack = (question.question_text || "").toLowerCase();
	for (const t of recent_activity_tokens) {
		if (typeof t !== "string" || t.length < 2) continue;
		if (haystack.includes(t.toLowerCase())) return HOOK_MATCH_BONUS;
	}
	return 1.0;
}

function kindLabelFor(question: Question): keyof typeof KIND_PRIORITY {
	const kind = String(question.kind || "");
	if (/avoidance|allerg|dietary/i.test(kind) || /allerg|can't.*eat|diet/i.test(question.question_text || "")) {
		return "dietary";
	}
	if (/equipment|kitchen|gear|tool/i.test(kind) || /equipment|gear|grill|oven|pan/i.test(question.question_text || "")) {
		return "equipment";
	}
	if (/tradition|ritual|holiday|sunday|friday/i.test(kind) || /tradition|ritual|holiday/i.test(question.question_text || "")) {
		return "tradition";
	}
	const traits = question.inferred_traits;
	if (traits && traits.some(rule => isTraitName(rule.trait_name))) {
		// Traits without a more specific category fall under "personality"
		// (the design's catch-all for the kitchen-personality dimensions).
		return "personality";
	}
	// Fallback: tier 0 questions that don't match the regex above are
	// existence-stub stuff — treat as personality (low priority) so they
	// don't accidentally outrank dietary in late tiers.
	return "personality";
}

function kindPriorityFor(question: Question): number {
	return KIND_PRIORITY[kindLabelFor(question)];
}

function isTraitName(name: string): name is TraitName {
	return typeof name === "string" && name.length > 0;
}

function clamp(value: number, lo: number, hi: number): number {
	if (!Number.isFinite(value)) return lo;
	if (value < lo) return lo;
	if (value > hi) return hi;
	return value;
}

function round3(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.round(value * 1000) / 1000;
}

// Re-exports for callers that want the type aliases without an extra import.
export type { Question, QuestionKind } from "./onboarding-questions";
