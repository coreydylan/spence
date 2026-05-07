// Chef-of-staff dispatch — onboarding-aware turn router.
//
// The chef-of-staff agent calls `chef_status_check` at the START of every turn
// before deciding whether to compose a meal, ask a question, or punt. The
// response packages everything the agent needs to choose its next action:
//
//   * The household's onboarding tier + completion %
//   * The next onboarding question (if any) the agent should surface
//   * `blocked_actions` — tools the agent SHOULD NOT call yet (only tier 0)
//   * A `recommendation` block with a primary_action + rationale + signals
//
// `chef_dispatch` is a higher-level helper: it calls chef_status_check itself,
// then translates the recommendation into a concrete `turn_plan` of Actions
// the agent should execute. Phase 1 stub — real intent parsing is later.
//
// The hard rules:
//   * No mise_onboarding_state row → tier_0_done=false, planning is BLOCKED.
//   * tier_0_done && !tier_1_done → planning is ALLOWED, but the recommended
//     action is to answer a tier-1 question. Agent decides.
//   * tier_1_done → planning is ready to roll. We populate `signals` with the
//     full HouseholdSignals bundle so the chef LLM has personality context.
//   * tier_2+ hooked question fires AND engagement_signal high enough → we
//     return `compose_with_inline_question` so the agent can sneak the deeper
//     question into the same turn as a meal compose.

import type { MiseGraphEnv } from "./types";
import {
	listResponses as listOnboardingResponses,
	statusOnboarding,
	type OnboardingState,
	type QuestionDescriptor,
} from "./onboarding";
import {
	allHookedQuestions,
	type HookedQuestion,
} from "./onboarding-questions";
import {
	computeHookDeps,
	evaluateHook,
} from "./onboarding-hooks";
import {
	ENGAGEMENT_TERSE,
	computeEngagementSignal,
} from "./onboarding-scheduler";
import {
	buildHouseholdSignals,
	type HouseholdSignals,
} from "./household-signals";

// ─── Public types ──────────────────────────────────────────────────────────

export type ChefPrimaryAction =
	| "answer_onboarding_question"
	| "compose_meal"
	| "compose_with_inline_question"
	| "ready_to_plan";

export interface ChefStatusOnboarding {
	current_tier: 0 | 1 | 2 | 3 | 4;
	tier_0_done: boolean;
	tier_1_done: boolean;
	completion_pct: number;
	next_question: QuestionDescriptor | null;
	blocked_actions: string[];
	engagement_signal: number;
}

export interface ChefRecommendation {
	primary_action: ChefPrimaryAction;
	rationale: string;
	next_question?: QuestionDescriptor;
	suggested_compose_args?: {
		plan_id_template: string;
		slot_template: string;
		tradition_hints: string[];
	};
}

export interface ChefStatusResult {
	household_id: string;
	onboarding: ChefStatusOnboarding;
	recommendation: ChefRecommendation;
	signals: HouseholdSignals | null;
}

export interface ChefDispatchAction {
	kind: "ask_question" | "ask_user" | "compose_meal";
	args: Record<string, unknown>;
	rationale: string;
}

export interface ChefDispatchResult {
	household_id: string;
	user_intent: string;
	status: ChefStatusResult;
	turn_plan: ChefDispatchAction[];
}

// Tools the agent must NOT call until tier_0 is complete. Surfaces in
// blocked_actions so the agent's pre-turn check can reject them out-of-hand.
const TIER_0_BLOCKED_TOOLS: ReadonlyArray<string> = [
	"plan_compose_meal",
	"plan_replace_meal",
	"plan_swap_ingredient",
	"plan_move_meal",
	"plan_split_batch",
];

// ─── chef_status_check ──────────────────────────────────────────────────────

export interface ChefStatusInput {
	household_id: string;
}

/**
 * The single source of truth for "what should the chef-of-staff do next?"
 *
 * We deliberately call statusOnboarding (which already handles missing state
 * by ensuring a row exists) but ALSO check whether a state row truly existed
 * BEFORE the call so we can distinguish "freshly minted, not started" from
 * "tier 0 in progress". statusOnboarding will create a default row if none
 * exists; that row will have current_tier=0 and no completion stamps.
 *
 * Logic ladder (tested in u109):
 *   1. tier_0 incomplete → blocked + answer-onboarding-question
 *   2. tier_0 done, tier_1 incomplete → answer-onboarding-question (no block)
 *   3. tier_1 done, no hooked tier_2+ firing → ready-to-plan (signals present)
 *   4. tier_1 done, hooked tier_2+ firing AND engagement decent →
 *      compose-with-inline-question (signals present, next_question = hook)
 */
export async function chefStatusCheck(
	env: MiseGraphEnv,
	input: ChefStatusInput,
): Promise<ChefStatusResult> {
	const household_id = (input.household_id || "").trim();
	if (!household_id) throw new Error("chefStatusCheck: household_id required");

	const status = await statusOnboarding(env, { household_id });
	const state = status.state;

	const tier_0_done = !!state.tier_0_completed_at;
	const tier_1_done = !!state.tier_1_completed_at;
	const current_tier = clampTier(state.current_tier);

	// Tier 0 incomplete → block planning, recommend the next question.
	if (!tier_0_done) {
		const next = status.next_question;
		const onboarding: ChefStatusOnboarding = {
			current_tier,
			tier_0_done: false,
			tier_1_done: false,
			completion_pct: status.completion_pct,
			next_question: next,
			blocked_actions: [...TIER_0_BLOCKED_TOOLS],
			engagement_signal: status.engagement_signal,
		};
		const recommendation: ChefRecommendation = {
			primary_action: "answer_onboarding_question",
			rationale: next
				? `Tier 0 onboarding is incomplete — household needs to answer "${next.kind}" before the chef can plan meals. Planning tools are blocked until tier 0 is satisfied.`
				: "Tier 0 onboarding is incomplete and no question is available — call household_onboarding_start to bootstrap state.",
			...(next ? { next_question: next } : {}),
		};
		return {
			household_id,
			onboarding,
			recommendation,
			signals: null,
		};
	}

	// Tier 0 done — planning is allowed from here on.
	if (!tier_1_done) {
		const next = status.next_question;
		const onboarding: ChefStatusOnboarding = {
			current_tier,
			tier_0_done: true,
			tier_1_done: false,
			completion_pct: status.completion_pct,
			next_question: next,
			blocked_actions: [],
			engagement_signal: status.engagement_signal,
		};
		const recommendation: ChefRecommendation = {
			primary_action: "answer_onboarding_question",
			rationale: next
				? `Tier 0 done; tier 1 still has open required questions (next: "${next.kind}"). Planning is allowed but answers will sharpen the meal plan — recommend asking before composing.`
				: "Tier 0 done; tier 1 partially answered. Planning is allowed.",
			...(next ? { next_question: next } : {}),
		};
		return {
			household_id,
			onboarding,
			recommendation,
			// Signals stay null until tier 1 — personality summary needs the
			// dinner_ritual answer to mean anything.
			signals: null,
		};
	}

	// Tier 1+ — full signal bundle is ready.
	const signals = await safeBuildSignals(env, household_id);
	const engagement = status.engagement_signal;

	// Look for a tier 2+ hooked question that fires AND would survive the
	// chattiness gate. Only inject when:
	//   * engagement is non-terse (>= ENGAGEMENT_TERSE)
	//   * the hook predicate fires (deps satisfy trigger)
	//   * the question hasn't been answered already
	const hooked = await maybePickHookedQuestion(env, household_id, engagement);

	const onboarding: ChefStatusOnboarding = {
		current_tier,
		tier_0_done: true,
		tier_1_done: true,
		completion_pct: status.completion_pct,
		next_question: hooked?.descriptor ?? null,
		blocked_actions: [],
		engagement_signal: engagement,
	};

	if (hooked) {
		const recommendation: ChefRecommendation = {
			primary_action: "compose_with_inline_question",
			rationale: `Tier 1 complete and a tier-${hooked.descriptor.tier} hook ("${hooked.descriptor.kind}") is firing — sneak the deeper question alongside the meal compose. Engagement signal ${engagement.toFixed(2)} supports an inline ask.`,
			next_question: hooked.descriptor,
		};
		return {
			household_id,
			onboarding,
			recommendation,
			signals,
		};
	}

	const recommendation: ChefRecommendation = {
		primary_action: "ready_to_plan",
		rationale: `Tier 1 onboarding complete. Personality + traditions + pantry + equipment loaded. Chef is ready to compose meals against the household's signal bundle.`,
		suggested_compose_args: {
			plan_id_template: "weekly:${household_id}:${start_date}",
			slot_template: "dinner",
			tradition_hints: signals?.traditions.map(t => `${t.name} (${t.cadence})`) ?? [],
		},
	};

	return {
		household_id,
		onboarding,
		recommendation,
		signals,
	};
}

// ─── chef_dispatch (Phase 1 stub) ───────────────────────────────────────────

export interface ChefDispatchInput {
	household_id: string;
	user_intent: string;
}

/**
 * Phase 1 stub: always calls chef_status_check first, then constructs a
 * 1-action turn plan based on `recommendation.primary_action`. Real intent
 * parsing comes later.
 */
export async function chefDispatch(
	env: MiseGraphEnv,
	input: ChefDispatchInput,
): Promise<ChefDispatchResult> {
	const household_id = (input.household_id || "").trim();
	const user_intent = typeof input.user_intent === "string" ? input.user_intent : "";
	if (!household_id) throw new Error("chefDispatch: household_id required");

	const status = await chefStatusCheck(env, { household_id });
	const turn_plan: ChefDispatchAction[] = [];

	switch (status.recommendation.primary_action) {
		case "answer_onboarding_question": {
			const q = status.recommendation.next_question ?? status.onboarding.next_question;
			if (q) {
				turn_plan.push({
					kind: "ask_question",
					args: { question: q },
					rationale: status.recommendation.rationale,
				});
			} else {
				// No question yet (state row missing entirely on a fresh household)
				// — fall back to bootstrapping onboarding.
				turn_plan.push({
					kind: "ask_user",
					args: {
						prompt: "Let's get you set up. What should I call your household?",
					},
					rationale: "No onboarding state — bootstrap by calling household_onboarding_start.",
				});
			}
			break;
		}
		case "compose_with_inline_question": {
			// Compose-with-inline-question: the agent should ask the user what
			// they want for dinner AND queue the hooked question alongside.
			turn_plan.push({
				kind: "ask_user",
				args: {
					prompt: "Tell me what kind of dinners you want this week — I have a quick follow-up too.",
					inline_question: status.recommendation.next_question,
				},
				rationale: status.recommendation.rationale,
			});
			break;
		}
		case "compose_meal":
		case "ready_to_plan": {
			turn_plan.push({
				kind: "ask_user",
				args: {
					prompt: "Tell me what kind of dinners you want this week and I'll start drafting the plan.",
					suggested_compose_args: status.recommendation.suggested_compose_args,
				},
				rationale: status.recommendation.rationale,
			});
			break;
		}
	}

	return {
		household_id,
		user_intent,
		status,
		turn_plan,
	};
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function clampTier(t: number): 0 | 1 | 2 | 3 | 4 {
	if (!Number.isFinite(t)) return 0;
	const n = Math.floor(t);
	if (n <= 0) return 0;
	if (n >= 4) return 4;
	return n as 0 | 1 | 2 | 3 | 4;
}

async function safeBuildSignals(
	env: MiseGraphEnv,
	household_id: string,
): Promise<HouseholdSignals | null> {
	try {
		return await buildHouseholdSignals(env, household_id);
	} catch {
		return null;
	}
}

interface HookedPick {
	descriptor: QuestionDescriptor;
	score_bonus: number;
}

/**
 * Pick the highest-priority tier 2+ hooked question whose trigger fires for
 * the household RIGHT NOW. Skips kinds the household has already answered or
 * skipped recently. Returns null when nothing fires (or engagement too low).
 */
async function maybePickHookedQuestion(
	env: MiseGraphEnv,
	household_id: string,
	engagement_signal: number,
): Promise<HookedPick | null> {
	if (!Number.isFinite(engagement_signal) || engagement_signal < ENGAGEMENT_TERSE) {
		// Terse user — don't sneak deeper questions in.
		return null;
	}

	const now_ms = Date.now();
	const deps = await computeHookDeps(env, household_id, now_ms).catch(() => null);
	if (!deps) return null;

	// Use a fresh engagement signal in deps so the chattiness math agrees with
	// what we computed above.
	deps.engagement_signal = engagement_signal;

	// Recently answered/skipped kinds — don't re-ask.
	const seen = new Set<string>();
	try {
		const recent = await listOnboardingResponses(env, household_id);
		for (const r of recent) seen.add(r.question_kind);
	} catch {
		// Best-effort.
	}

	let best: { hq: HookedQuestion; rendered: string } | null = null;
	for (const hq of allHookedQuestions()) {
		if (seen.has(hq.kind)) continue;
		const evaluated = evaluateHook(hq, deps);
		if (!evaluated.fires) continue;
		// Tier 2 takes precedence over tier 3+ (lower tier first).
		if (!best || hq.tier < best.hq.tier) {
			best = { hq, rendered: evaluated.rendered_text };
		}
	}

	if (!best) return null;
	const descriptor: QuestionDescriptor = {
		kind: best.hq.kind as QuestionDescriptor["kind"],
		// QuestionDescriptor.tier is 0|1 in the existing type; we widen via cast
		// because tier 2+ is meaningful in this dispatch context.
		tier: best.hq.tier as unknown as QuestionDescriptor["tier"],
		required: false,
		question_text: best.rendered,
		options: best.hq.options ? best.hq.options.map(o => ({ ...o })) : undefined,
		free_text_allowed: best.hq.free_text_allowed,
	};
	return { descriptor, score_bonus: 1.5 };
}

// Re-exports for callers that want them.
export { TIER_0_BLOCKED_TOOLS };
export type { OnboardingState };
