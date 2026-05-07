// Onboarding Phase A — state machine, response log, Bayesian-ish trait
// inference, and tier advancement.
//
// All four MCP-facing entry points (start / status / answer / skip) live
// here. plan-world-mcp.ts wraps each one in a thin tool function.
//
// State model:
//   * mise_onboarding_state has one row per household. We bump current_tier
//     when ALL required questions in the active tier are either answered or
//     explicitly skipped. tier_X_completed_at is the wall-clock stamp.
//   * mise_onboarding_responses is append-only. Each row is one ask + one
//     answer (or one skip — response_text=null).
//   * mise_household_traits caches the 7 inferred personality dims. Phase A
//     only fires updates from tier 1.3 (dinner_ritual); the rest stay at
//     value=0.5, confidence=0 until Phase C's observation pipeline runs.
//
// Question selection rule (Phase A is simple):
//   For the household's current_tier, walk TIER_X_QUESTIONS in declaration
//   order and return the first question whose `kind` does not appear in the
//   responses log for that household. When no such question exists, return
//   null — the caller should consider the tier "satisfied for this turn."
//
// The *real* daily scheduler (score-based picking from the active question
// bag) is Phase C work. Phase A just wants the linear walk to be correct.

import type { MiseGraphEnv } from "./types";
import {
	TIER_0_QUESTIONS,
	TIER_1_QUESTIONS,
	TRAIT_NAMES,
	allQuestions,
	findQuestion,
	isKnownTraitName,
	normalizeChoice,
	type Question,
	type QuestionKind,
	type TraitName,
} from "./onboarding-questions";

const TIER_COUNT = 5; // 0..4 — Phase A only ships 0+1, but completion_pct
                      // divides by 5 so the UI bar makes sense long-term.

// ─── Public types ───────────────────────────────────────────────────────────

export interface OnboardingState {
	household_id: string;
	current_tier: number;
	tier_0_completed_at: string | null;
	tier_1_completed_at: string | null;
	tier_2_completed_at: string | null;
	tier_3_completed_at: string | null;
	active_question_bag_json: string | null;
	engagement_signal: number;
	last_question_asked_at: string | null;
	questions_asked_count: number;
	questions_answered_count: number;
	questions_skipped_count: number;
	updated_at_ms: number;
}

export interface ResponseRow {
	response_id: string;
	household_id: string;
	member_id: string | null;
	question_kind: string;
	question_text: string;
	response_text: string | null;
	response_chars: number;
	asked_at_ms: number;
	answered_at_ms: number | null;
	inferred_traits_json: string | null;
	tier: number;
}

export interface Trait {
	household_id: string;
	trait_name: TraitName;
	member_id: string | null;
	trait_value: number;
	confidence: number;
	last_evidence_at_ms: number;
	evidence_count: number;
}

export interface TraitDelta {
	trait_name: TraitName;
	prev_value: number;
	prev_confidence: number;
	new_value: number;
	new_confidence: number;
	delta_value: number;
	delta_confidence: number;
}

export interface QuestionDescriptor {
	kind: QuestionKind;
	tier: 0 | 1;
	required: boolean;
	question_text: string;
	options?: Array<{ value: string; label: string }>;
	free_text_allowed: boolean;
}

export interface TierProgress {
	0: "pending" | "in_progress" | "complete";
	1: "pending" | "in_progress" | "complete";
	2: "pending" | "in_progress" | "complete";
	3: "pending" | "in_progress" | "complete";
}

export interface StartResult {
	state: OnboardingState;
	next_question: QuestionDescriptor | null;
	tier_progress: TierProgress;
}

export interface AnswerResult {
	recorded: true;
	inferred_traits: TraitDelta[];
	next_question: QuestionDescriptor | null;
	tier_advanced: boolean;
	state: OnboardingState;
}

export interface SkipResult {
	recorded: true;
	inferred_traits: TraitDelta[];
	next_question: QuestionDescriptor | null;
	tier_advanced: boolean;
	state: OnboardingState;
}

export interface StatusResult {
	state: OnboardingState;
	traits: Trait[];
	next_question: QuestionDescriptor | null;
	completion_pct: number;
	engagement_signal: number;
}

// ─── DB column lists ────────────────────────────────────────────────────────

const STATE_COLS = `household_id, current_tier,
	tier_0_completed_at, tier_1_completed_at,
	tier_2_completed_at, tier_3_completed_at,
	active_question_bag_json, engagement_signal,
	last_question_asked_at, questions_asked_count,
	questions_answered_count, questions_skipped_count,
	updated_at_ms`;

const RESPONSE_COLS = `response_id, household_id, member_id,
	question_kind, question_text, response_text, response_chars,
	asked_at_ms, answered_at_ms, inferred_traits_json, tier`;

const TRAIT_COLS = `household_id, trait_name, member_id,
	trait_value, confidence, last_evidence_at_ms, evidence_count`;

interface StateRow {
	household_id: string;
	current_tier: number;
	tier_0_completed_at: string | null;
	tier_1_completed_at: string | null;
	tier_2_completed_at: string | null;
	tier_3_completed_at: string | null;
	active_question_bag_json: string | null;
	engagement_signal: number;
	last_question_asked_at: string | null;
	questions_asked_count: number;
	questions_answered_count: number;
	questions_skipped_count: number;
	updated_at_ms: number;
}

interface ResponseStorageRow {
	response_id: string;
	household_id: string;
	member_id: string | null;
	question_kind: string;
	question_text: string;
	response_text: string | null;
	response_chars: number;
	asked_at_ms: number;
	answered_at_ms: number | null;
	inferred_traits_json: string | null;
	tier: number;
}

interface TraitRow {
	household_id: string;
	trait_name: string;
	member_id: string | null;
	trait_value: number;
	confidence: number;
	last_evidence_at_ms: number;
	evidence_count: number;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface StartInput {
	household_id: string;
	household_name?: string;
}

export async function startOnboarding(
	env: MiseGraphEnv,
	input: StartInput,
): Promise<StartResult> {
	const household_id = (input.household_id || "").trim();
	if (!household_id) throw new Error("startOnboarding: household_id required");

	const existing = await loadState(env, household_id);
	if (existing) {
		// Idempotent — just return the current view.
		return buildStartResult(env, existing);
	}

	const now = Date.now();
	const initial: StateRow = {
		household_id,
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
	await persistState(env, initial);
	return buildStartResult(env, initial);
}

export interface AnswerInput {
	household_id: string;
	question_kind: string;
	response_text: string;
	member_id?: string;
}

export async function answerOnboarding(
	env: MiseGraphEnv,
	input: AnswerInput,
): Promise<AnswerResult> {
	const household_id = (input.household_id || "").trim();
	const question_kind = (input.question_kind || "").trim();
	const response_text = typeof input.response_text === "string" ? input.response_text : "";
	if (!household_id) throw new Error("answerOnboarding: household_id required");
	if (!question_kind) throw new Error("answerOnboarding: question_kind required");
	if (!response_text.trim()) throw new Error("answerOnboarding: response_text required (use household_onboarding_skip to skip)");

	const question = findQuestion(question_kind);
	if (!question) throw new Error(`answerOnboarding: unknown question_kind '${question_kind}'`);

	const state = await ensureState(env, household_id);
	const now = Date.now();

	// Apply trait inference rules from the question definition.
	const traitDeltas = await applyQuestionTraits(env, household_id, question, response_text, now);

	// Append a response row.
	const response_chars = response_text.length;
	const response_id = makeResponseId(household_id, question_kind, now);
	const traitsForLog = traitDeltas.map(d => ({
		trait_name: d.trait_name,
		new_value: d.new_value,
		new_confidence: d.new_confidence,
	}));
	const row: ResponseStorageRow = {
		response_id,
		household_id,
		member_id: input.member_id ?? null,
		question_kind,
		question_text: question.question_text,
		response_text,
		response_chars,
		asked_at_ms: now,
		answered_at_ms: now,
		inferred_traits_json: traitsForLog.length ? JSON.stringify(traitsForLog) : null,
		tier: question.tier,
	};
	await persistResponse(env, row);

	// Mirror the answer to the household profile / member if requested.
	await applyWriteBack(env, household_id, question, response_text);

	// Advance counters + maybe advance tier.
	state.questions_asked_count = state.questions_asked_count + 1;
	state.questions_answered_count = state.questions_answered_count + 1;
	state.last_question_asked_at = new Date(now).toISOString();
	state.updated_at_ms = now;
	const tierAdvanced = await maybeAdvanceTier(env, state, now);
	await persistState(env, state);

	const next = await pickNextQuestion(env, household_id, state);

	return {
		recorded: true,
		inferred_traits: traitDeltas,
		next_question: next,
		tier_advanced: tierAdvanced,
		state: rowToState(state),
	};
}

export interface SkipInput {
	household_id: string;
	question_kind: string;
	member_id?: string;
}

export async function skipOnboarding(
	env: MiseGraphEnv,
	input: SkipInput,
): Promise<SkipResult> {
	const household_id = (input.household_id || "").trim();
	const question_kind = (input.question_kind || "").trim();
	if (!household_id) throw new Error("skipOnboarding: household_id required");
	if (!question_kind) throw new Error("skipOnboarding: question_kind required");

	const question = findQuestion(question_kind);
	if (!question) throw new Error(`skipOnboarding: unknown question_kind '${question_kind}'`);

	const state = await ensureState(env, household_id);
	const now = Date.now();
	const response_id = makeResponseId(household_id, question_kind, now);

	const row: ResponseStorageRow = {
		response_id,
		household_id,
		member_id: input.member_id ?? null,
		question_kind,
		question_text: question.question_text,
		response_text: null,
		response_chars: 0,
		asked_at_ms: now,
		answered_at_ms: null,
		inferred_traits_json: null,
		tier: question.tier,
	};
	await persistResponse(env, row);

	state.questions_asked_count = state.questions_asked_count + 1;
	state.questions_skipped_count = state.questions_skipped_count + 1;
	state.last_question_asked_at = new Date(now).toISOString();
	state.updated_at_ms = now;
	const tierAdvanced = await maybeAdvanceTier(env, state, now);
	await persistState(env, state);

	const next = await pickNextQuestion(env, household_id, state);

	return {
		recorded: true,
		inferred_traits: [],
		next_question: next,
		tier_advanced: tierAdvanced,
		state: rowToState(state),
	};
}

export interface StatusInput {
	household_id: string;
}

export async function statusOnboarding(
	env: MiseGraphEnv,
	input: StatusInput,
): Promise<StatusResult> {
	const household_id = (input.household_id || "").trim();
	if (!household_id) throw new Error("statusOnboarding: household_id required");

	const state = await ensureState(env, household_id);
	const traits = await listTraits(env, household_id);
	const next = await pickNextQuestion(env, household_id, state);
	const completion_pct = computeCompletionPct(state);
	return {
		state: rowToState(state),
		traits,
		next_question: next,
		completion_pct,
		engagement_signal: state.engagement_signal,
	};
}

// ─── Trait inference ────────────────────────────────────────────────────────

export interface ApplyTraitDeltaInput {
	old_value: number;
	old_confidence: number;
	delta_value: number;
	delta_confidence: number;
}

export interface ApplyTraitDeltaResult {
	new_value: number;
	new_confidence: number;
}

const CONFIDENCE_DECAY = 0.7;

export function applyTraitDelta(input: ApplyTraitDeltaInput): ApplyTraitDeltaResult {
	const old_value = clamp01(Number.isFinite(input.old_value) ? input.old_value : 0.5);
	const old_confidence = clamp01(Number.isFinite(input.old_confidence) ? input.old_confidence : 0);
	const delta_value = clamp01(Number.isFinite(input.delta_value) ? input.delta_value : 0.5);
	const delta_confidence = Math.max(0, Number.isFinite(input.delta_confidence) ? input.delta_confidence : 0);

	const totalConf = old_confidence + delta_confidence;
	const new_value = totalConf > 0
		? (old_value * old_confidence + delta_value * delta_confidence) / totalConf
		: old_value;
	const new_confidence = clamp01(old_confidence + delta_confidence * CONFIDENCE_DECAY);
	return {
		new_value: round3(clamp01(new_value)),
		new_confidence: round3(new_confidence),
	};
}

async function applyQuestionTraits(
	env: MiseGraphEnv,
	household_id: string,
	question: Question,
	response_text: string,
	now: number,
): Promise<TraitDelta[]> {
	const rules = question.inferred_traits;
	if (!rules || rules.length === 0) return [];
	const out: TraitDelta[] = [];
	for (const rule of rules) {
		let matched = false;
		try {
			matched = !!rule.response_predicate(response_text);
		} catch {
			matched = false;
		}
		if (!matched) continue;
		if (!isKnownTraitName(rule.trait_name)) continue;

		const existing = await loadTrait(env, household_id, rule.trait_name);
		const old_value = existing?.trait_value ?? 0.5;
		const old_confidence = existing?.confidence ?? 0;
		const evidence_count = (existing?.evidence_count ?? 0) + 1;
		const updated = applyTraitDelta({
			old_value,
			old_confidence,
			delta_value: rule.delta_value,
			delta_confidence: rule.delta_confidence,
		});
		await persistTrait(env, {
			household_id,
			trait_name: rule.trait_name,
			member_id: null,
			trait_value: updated.new_value,
			confidence: updated.new_confidence,
			last_evidence_at_ms: now,
			evidence_count,
		});
		out.push({
			trait_name: rule.trait_name,
			prev_value: round3(old_value),
			prev_confidence: round3(old_confidence),
			new_value: updated.new_value,
			new_confidence: updated.new_confidence,
			delta_value: rule.delta_value,
			delta_confidence: rule.delta_confidence,
		});
	}
	return out;
}

// ─── Question advancement / scheduling ──────────────────────────────────────

async function pickNextQuestion(
	env: MiseGraphEnv,
	household_id: string,
	state: StateRow,
): Promise<QuestionDescriptor | null> {
	// For "what comes next" we want to skip questions the user has already
	// touched at all (answered OR skipped) — the scheduler is allowed to
	// resurface them later but never twice in a row.
	const seen = await loadSeenKinds(env, household_id);
	const tiersToWalk: Array<0 | 1> = [];
	if (state.current_tier <= 0) tiersToWalk.push(0);
	tiersToWalk.push(1);
	for (const tier of tiersToWalk) {
		const bank = tier === 0 ? TIER_0_QUESTIONS : TIER_1_QUESTIONS;
		for (const q of bank) {
			if (!seen.has(q.kind)) {
				return toDescriptor(q);
			}
		}
	}
	return null;
}

async function maybeAdvanceTier(
	env: MiseGraphEnv,
	state: StateRow,
	now: number,
): Promise<boolean> {
	let advanced = false;
	// For tier advancement we only count *answered* (non-null response_text)
	// questions — skips never satisfy a required question. Optional questions
	// don't gate advancement at all.
	const answered = await loadAnsweredKinds(env, state.household_id);

	if (state.current_tier === 0 && allRequiredAnswered(TIER_0_QUESTIONS, answered)) {
		state.current_tier = 1;
		state.tier_0_completed_at = new Date(now).toISOString();
		advanced = true;
	}
	if (state.current_tier === 1 && allRequiredAnswered(TIER_1_QUESTIONS, answered)) {
		state.current_tier = 2;
		state.tier_1_completed_at = new Date(now).toISOString();
		advanced = true;
	}
	return advanced;
}

function allRequiredAnswered(
	bank: ReadonlyArray<Question>,
	answered: Set<string>,
): boolean {
	for (const q of bank) {
		if (!q.required) continue;
		if (!answered.has(q.kind)) return false;
	}
	return true;
}

// ─── Mirror answers onto the existing profile/member columns ────────────────

async function applyWriteBack(
	env: MiseGraphEnv,
	household_id: string,
	question: Question,
	response_text: string,
): Promise<void> {
	if (!question.writes_to) return;
	if (question.writes_to.table !== "mise_household_profiles") return;
	const allowed = new Set(["dinner_ritual", "cook_frequency", "pantry_intake_mode"]);
	if (!allowed.has(question.writes_to.column)) return;
	const value = response_text.trim();
	if (!value) return;
	const now = new Date().toISOString();

	// Make sure a profile row exists — seed a minimal one when missing.
	// (We use SELECT-then-INSERT-OR-REPLACE because mock-d1 in tests doesn't
	// implement INSERT OR IGNORE, but D1 supports both. The full profile
	// upsert path lives in household-model.ts; we deliberately do not pull
	// it in here to keep the writeback decoupled.)
	let existed = false;
	try {
		const row = await env.DB.prepare(
			`SELECT household_id FROM mise_household_profiles WHERE household_id = ?`,
		).bind(household_id).first<{ household_id: string }>();
		existed = !!row;
	} catch {
		// Table missing — caller hasn't migrated household-memory yet. Skip
		// the mirror; the response row is still the source of truth.
		return;
	}
	if (!existed) {
		try {
			await env.DB.prepare(
				`INSERT OR REPLACE INTO mise_household_profiles
					(household_id, display_name, people_count, dietary_json,
					 equipment_json, current_anchors_json, cuisine_preferences_json,
					 default_pantry_json, shop_preferences_json, notes,
					 created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).bind(
				household_id, null, 2, "[]", "[]", "[]", "{}", "[]", null, null,
				now, now,
			).run();
		} catch {
			return;
		}
	}
	try {
		await env.DB.prepare(
			`UPDATE mise_household_profiles SET ${question.writes_to.column} = ?, updated_at = ?
			 WHERE household_id = ?`,
		).bind(value, now, household_id).run();
	} catch {
		// Column missing on this DB — onboarding migration probably hasn't run.
		// We don't want the answer flow to fail just because the optional
		// mirror write is unavailable; the response row is the source of truth.
	}
}

// ─── DB layer ───────────────────────────────────────────────────────────────

async function loadState(env: MiseGraphEnv, household_id: string): Promise<StateRow | null> {
	try {
		const row = await env.DB.prepare(
			`SELECT ${STATE_COLS} FROM mise_onboarding_state WHERE household_id = ?`,
		).bind(household_id).first<StateRow>();
		return row || null;
	} catch {
		return null;
	}
}

async function ensureState(env: MiseGraphEnv, household_id: string): Promise<StateRow> {
	const existing = await loadState(env, household_id);
	if (existing) return existing;
	const now = Date.now();
	const initial: StateRow = {
		household_id,
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
	await persistState(env, initial);
	return initial;
}

async function persistState(env: MiseGraphEnv, row: StateRow): Promise<void> {
	await env.DB.prepare(
		`INSERT OR REPLACE INTO mise_onboarding_state (${STATE_COLS})
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(
		row.household_id,
		row.current_tier,
		row.tier_0_completed_at,
		row.tier_1_completed_at,
		row.tier_2_completed_at,
		row.tier_3_completed_at,
		row.active_question_bag_json,
		row.engagement_signal,
		row.last_question_asked_at,
		row.questions_asked_count,
		row.questions_answered_count,
		row.questions_skipped_count,
		row.updated_at_ms,
	).run();
}

async function persistResponse(env: MiseGraphEnv, row: ResponseStorageRow): Promise<void> {
	await env.DB.prepare(
		`INSERT OR REPLACE INTO mise_onboarding_responses (${RESPONSE_COLS})
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(
		row.response_id,
		row.household_id,
		row.member_id,
		row.question_kind,
		row.question_text,
		row.response_text,
		row.response_chars,
		row.asked_at_ms,
		row.answered_at_ms,
		row.inferred_traits_json,
		row.tier,
	).run();
}

async function loadAnsweredKinds(env: MiseGraphEnv, household_id: string): Promise<Set<string>> {
	// "Answered" = response_text is non-null. Skips never count.
	const out = new Set<string>();
	try {
		const result = await env.DB.prepare(
			`SELECT response_id, household_id, member_id, question_kind,
				question_text, response_text, response_chars,
				asked_at_ms, answered_at_ms, inferred_traits_json, tier
			 FROM mise_onboarding_responses
			 WHERE household_id = ?
			 ORDER BY asked_at_ms DESC`,
		).bind(household_id).all<ResponseStorageRow>();
		for (const r of result.results || []) {
			if (!r || typeof r.question_kind !== "string") continue;
			if (r.response_text === null || r.response_text === undefined) continue;
			out.add(r.question_kind);
		}
	} catch {
		// Table missing — caller hasn't migrated yet.
	}
	return out;
}

async function loadSeenKinds(env: MiseGraphEnv, household_id: string): Promise<Set<string>> {
	// "Seen" = there exists any response row (answered OR skipped). Used by
	// the next-question picker so we don't re-ask a question the same turn.
	const out = new Set<string>();
	try {
		const result = await env.DB.prepare(
			`SELECT response_id, household_id, member_id, question_kind,
				question_text, response_text, response_chars,
				asked_at_ms, answered_at_ms, inferred_traits_json, tier
			 FROM mise_onboarding_responses
			 WHERE household_id = ?
			 ORDER BY asked_at_ms DESC`,
		).bind(household_id).all<ResponseStorageRow>();
		for (const r of result.results || []) {
			if (r && typeof r.question_kind === "string") out.add(r.question_kind);
		}
	} catch {
		// Table missing.
	}
	return out;
}

export async function listResponses(env: MiseGraphEnv, household_id: string): Promise<ResponseRow[]> {
	const out: ResponseRow[] = [];
	try {
		const result = await env.DB.prepare(
			`SELECT response_id, household_id, member_id, question_kind,
				question_text, response_text, response_chars,
				asked_at_ms, answered_at_ms, inferred_traits_json, tier
			 FROM mise_onboarding_responses
			 WHERE household_id = ?
			 ORDER BY asked_at_ms DESC`,
		).bind(household_id).all<ResponseStorageRow>();
		for (const r of result.results || []) {
			out.push({
				response_id: r.response_id,
				household_id: r.household_id,
				member_id: r.member_id ?? null,
				question_kind: r.question_kind,
				question_text: r.question_text,
				response_text: r.response_text ?? null,
				response_chars: typeof r.response_chars === "number" ? r.response_chars : 0,
				asked_at_ms: typeof r.asked_at_ms === "number" ? r.asked_at_ms : 0,
				answered_at_ms: typeof r.answered_at_ms === "number" ? r.answered_at_ms : null,
				inferred_traits_json: r.inferred_traits_json ?? null,
				tier: typeof r.tier === "number" ? r.tier : 0,
			});
		}
	} catch {
		// Table missing.
	}
	return out;
}

async function loadTrait(
	env: MiseGraphEnv,
	household_id: string,
	trait_name: TraitName,
): Promise<Trait | null> {
	try {
		const row = await env.DB.prepare(
			`SELECT ${TRAIT_COLS} FROM mise_household_traits
			 WHERE household_id = ? AND trait_name = ?`,
		).bind(household_id, trait_name).first<TraitRow>();
		return row ? rowToTrait(row) : null;
	} catch {
		return null;
	}
}

async function persistTrait(env: MiseGraphEnv, trait: Trait): Promise<void> {
	await env.DB.prepare(
		`INSERT OR REPLACE INTO mise_household_traits (${TRAIT_COLS})
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).bind(
		trait.household_id,
		trait.trait_name,
		trait.member_id,
		trait.trait_value,
		trait.confidence,
		trait.last_evidence_at_ms,
		trait.evidence_count,
	).run();
}

export async function listTraits(env: MiseGraphEnv, household_id: string): Promise<Trait[]> {
	const out: Trait[] = [];
	try {
		const result = await env.DB.prepare(
			`SELECT ${TRAIT_COLS} FROM mise_household_traits
			 WHERE household_id = ?
			 ORDER BY trait_name ASC`,
		).bind(household_id).all<TraitRow>();
		for (const r of result.results || []) {
			const trait = rowToTrait(r);
			if (trait) out.push(trait);
		}
	} catch {
		// Table missing.
	}
	return out;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function rowToState(row: StateRow): OnboardingState {
	return {
		household_id: row.household_id,
		current_tier: row.current_tier,
		tier_0_completed_at: row.tier_0_completed_at,
		tier_1_completed_at: row.tier_1_completed_at,
		tier_2_completed_at: row.tier_2_completed_at,
		tier_3_completed_at: row.tier_3_completed_at,
		active_question_bag_json: row.active_question_bag_json,
		engagement_signal: row.engagement_signal,
		last_question_asked_at: row.last_question_asked_at,
		questions_asked_count: row.questions_asked_count,
		questions_answered_count: row.questions_answered_count,
		questions_skipped_count: row.questions_skipped_count,
		updated_at_ms: row.updated_at_ms,
	};
}

function rowToTrait(row: TraitRow): Trait | null {
	if (!isKnownTraitName(row.trait_name)) return null;
	return {
		household_id: row.household_id,
		trait_name: row.trait_name,
		member_id: row.member_id ?? null,
		trait_value: round3(clamp01(typeof row.trait_value === "number" ? row.trait_value : 0.5)),
		confidence: round3(clamp01(typeof row.confidence === "number" ? row.confidence : 0)),
		last_evidence_at_ms: typeof row.last_evidence_at_ms === "number" ? row.last_evidence_at_ms : 0,
		evidence_count: typeof row.evidence_count === "number" ? row.evidence_count : 0,
	};
}

function toDescriptor(q: Question): QuestionDescriptor {
	return {
		kind: q.kind,
		tier: q.tier,
		required: q.required,
		question_text: q.question_text,
		options: q.options ? q.options.map(o => ({ ...o })) : undefined,
		free_text_allowed: q.free_text_allowed,
	};
}

async function buildStartResult(env: MiseGraphEnv, state: StateRow): Promise<StartResult> {
	const next = await pickNextQuestion(env, state.household_id, state);
	return {
		state: rowToState(state),
		next_question: next,
		tier_progress: tierProgress(state),
	};
}

function tierProgress(state: StateRow): TierProgress {
	const stage = (idx: number, completedAt: string | null): "pending" | "in_progress" | "complete" => {
		if (completedAt) return "complete";
		if (state.current_tier === idx) return "in_progress";
		if (state.current_tier > idx) return "complete";
		return "pending";
	};
	return {
		0: stage(0, state.tier_0_completed_at),
		1: stage(1, state.tier_1_completed_at),
		2: stage(2, state.tier_2_completed_at),
		3: stage(3, state.tier_3_completed_at),
	};
}

function computeCompletionPct(state: StateRow): number {
	let completed = 0;
	if (state.tier_0_completed_at) completed++;
	if (state.tier_1_completed_at) completed++;
	if (state.tier_2_completed_at) completed++;
	if (state.tier_3_completed_at) completed++;
	return round3(completed / TIER_COUNT);
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

function round3(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.round(value * 1000) / 1000;
}

function makeResponseId(household_id: string, question_kind: string, now: number): string {
	const rand = Math.random().toString(36).slice(2, 8);
	return `obr_${household_id}__${question_kind}__${now}_${rand}`;
}

// Re-export for tests that want to introspect the bank from the same import.
export { TIER_0_QUESTIONS, TIER_1_QUESTIONS, TRAIT_NAMES, allQuestions, normalizeChoice };
