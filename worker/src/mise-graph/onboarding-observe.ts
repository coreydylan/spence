// Onboarding Phase C — Behavioral observation pipeline.
//
// The agent learns more from what users *do* than what they *say*. Each
// time a meaningful tool fires (compose, cancel, swap, replace, mark-eaten,
// brigade-mode-used, pantry-utilization) we write a synthetic
// mise_onboarding_responses row with question_kind = `_observed:<event>`,
// observation text as response_text, and inferred_traits_json carrying any
// trait deltas. The Bayesian-ish update from Phase A then runs over those
// deltas exactly as if a user had answered a forced-choice question.
//
// This file owns:
//   1. observeResponse(env, input) — the public MCP-facing entry point.
//   2. observeFromTool(env, ...) — convenience wrapper used by plan-world-mcp
//      so write-tools can fire-and-forget an observation without breaking
//      the planning flow on a write failure.
//   3. The observation→trait inference rule table for Phase C.

import type { MiseGraphEnv } from "./types";
import {
	applyTraitDelta,
	type Trait,
	type TraitDelta,
} from "./onboarding";
import {
	TRAIT_NAMES,
	isKnownTraitName,
	type TraitName,
} from "./onboarding-questions";
import { loadActivePlan } from "./active-plans";

// ─── Public types ───────────────────────────────────────────────────────────

export type ObservationKind =
	| "meal_composed"
	| "meal_cancelled"
	| "meal_eaten"
	| "ingredient_swap"
	| "meal_replaced"
	| "brigade_mode_used"
	| "pantry_utilization_high"
	// Allow `_observed:<anything>` for forward-compat / agent-driven kinds.
	| (string & { _brand?: never });

export interface ObservedTraitDelta {
	trait_name: TraitName;
	delta_value: number;
	delta_confidence: number;
}

export interface ObserveInput {
	household_id: string;
	observation_kind: ObservationKind;
	observation_text: string;
	member_id?: string;
	/**
	 * Optional explicit trait deltas. If omitted, the rule table below
	 * derives them from observation_kind + observation_text.
	 */
	inferred_traits?: ReadonlyArray<ObservedTraitDelta>;
	/**
	 * Optional context the inference rules can read. Currently only
	 * `cancel_within_2h: boolean` is consulted (for the meal_cancelled →
	 * quick_vs_project rule). Forward-compat for Phase D pantry/brigade rules.
	 */
	context?: ObservationContext;
	/**
	 * Override the wall-clock — tests and replays only.
	 */
	now_ms?: number;
}

export interface ObservationContext {
	cancel_within_2h?: boolean;
	repeat_count?: number;
	pantry_utilization?: number;
	[key: string]: unknown;
}

export interface ObserveResult {
	recorded: true;
	traits_updated: number;
	deltas: TraitDelta[];
	response_id: string;
}

// ─── Inference rule table ───────────────────────────────────────────────────
//
// Returns a list of (trait, delta_value, delta_confidence) tuples. The
// caller (observeResponse) feeds each through applyTraitDelta and persists
// the result via INSERT OR REPLACE on mise_household_traits.
//
// Phase C ships:
//   * meal_cancelled within 2h cook_window  → quick_vs_project ↑ (toward 1.0)
//   * ingredient_swap                       → precision_vs_improvisation ↑
//   * repeat_count ≥ 3 (same recipe weekly) → comfort_vs_adventure ↓ (toward 0)
//
// Phase D / TODO:
//   * brigade_mode_used                     → solo_cook_vs_social_cook ↑
//   * pantry_utilization > 0.75             → pantry_first_vs_shop_fresh ↓

export function inferTraitsFromObservation(
	observation_kind: ObservationKind,
	observation_text: string,
	context: ObservationContext = {},
): ObservedTraitDelta[] {
	const out: ObservedTraitDelta[] = [];
	const kind = String(observation_kind);

	// Strip the `_observed:` prefix if the caller passed it pre-formatted.
	const bareKind = kind.startsWith("_observed:") ? kind.slice("_observed:".length) : kind;

	switch (bareKind) {
		case "meal_cancelled": {
			// Spec: cancellation within 2h of cook_window_start signals time
			// pressure → quick_vs_project pushed toward 1.0. We accept the
			// signal from caller context; if absent we still fire a milder
			// version (cancellation is at least *some* evidence of pressure).
			const within2h = context.cancel_within_2h === true;
			out.push({
				trait_name: "quick_vs_project",
				delta_value: 1.0,
				delta_confidence: within2h ? 0.15 : 0.05,
			});
			break;
		}
		case "ingredient_swap": {
			// Sub-request like "swap olive oil for ghee" → improvisation.
			out.push({
				trait_name: "precision_vs_improvisation",
				delta_value: 1.0,
				delta_confidence: 0.15,
			});
			break;
		}
		case "meal_composed": {
			// Acceptance evidence — same recipe repeated 3+ weeks running pulls
			// comfort_vs_adventure toward 0 (comfort). Caller passes
			// `repeat_count`; if undefined we don't fire a delta on a single
			// compose (would be too noisy).
			const repeats = typeof context.repeat_count === "number" ? context.repeat_count : 0;
			if (repeats >= 3) {
				out.push({
					trait_name: "comfort_vs_adventure",
					delta_value: 0.0,
					delta_confidence: 0.2,
				});
			}
			break;
		}
		case "meal_eaten": {
			// Spec table doesn't pin a specific delta for "ate it" alone.
			// The signal lives in repeat patterns, which the meal_composed
			// hook handles. Leave the row as a logged observation only.
			break;
		}
		case "meal_replaced": {
			// Replace = "I want a different meal" — mild dissatisfaction. We
			// don't pin a strong trait delta to this in Phase C; it's logged
			// for future analysis (recipe-affinity reweighting in Phase D+).
			break;
		}
		case "brigade_mode_used": {
			// TODO: Phase D — needs brigade-presence detection. Stubbed so
			// callers can already log the observation; the trait will fire
			// when Phase D wires the multi-WS check.
			out.push({
				trait_name: "solo_cook_vs_social_cook",
				delta_value: 1.0,
				delta_confidence: 0.2,
			});
			break;
		}
		case "pantry_utilization_high": {
			// TODO: Phase D — requires reading shop-run cadence + pantry
			// inventory delta. We support it here for forward-compat; the
			// shop-cycle daemon will start firing it in Phase D.
			out.push({
				trait_name: "pantry_first_vs_shop_fresh",
				delta_value: 0.0,
				delta_confidence: 0.15,
			});
			break;
		}
		default: {
			// Free-form observation kind. We don't infer anything — the row is
			// logged so the agent can pattern-match it later.
			void observation_text;
			break;
		}
	}

	return out;
}

// ─── Persistence ────────────────────────────────────────────────────────────

const TRAIT_COLS = `household_id, trait_name, member_id,
	trait_value, confidence, last_evidence_at_ms, evidence_count`;

const RESPONSE_COLS = `response_id, household_id, member_id,
	question_kind, question_text, response_text, response_chars,
	asked_at_ms, answered_at_ms, inferred_traits_json, tier`;

interface TraitStorageRow {
	household_id: string;
	trait_name: string;
	member_id: string | null;
	trait_value: number;
	confidence: number;
	last_evidence_at_ms: number;
	evidence_count: number;
}

async function loadTraitRow(
	env: MiseGraphEnv,
	household_id: string,
	trait_name: TraitName,
): Promise<Trait | null> {
	try {
		const row = await env.DB.prepare(
			`SELECT ${TRAIT_COLS} FROM mise_household_traits
			 WHERE household_id = ? AND trait_name = ?`,
		).bind(household_id, trait_name).first<TraitStorageRow>();
		if (!row) return null;
		if (!isKnownTraitName(row.trait_name)) return null;
		return {
			household_id: row.household_id,
			trait_name: row.trait_name,
			member_id: row.member_id ?? null,
			trait_value: typeof row.trait_value === "number" ? row.trait_value : 0.5,
			confidence: typeof row.confidence === "number" ? row.confidence : 0,
			last_evidence_at_ms: typeof row.last_evidence_at_ms === "number" ? row.last_evidence_at_ms : 0,
			evidence_count: typeof row.evidence_count === "number" ? row.evidence_count : 0,
		};
	} catch {
		return null;
	}
}

async function persistTraitRow(env: MiseGraphEnv, trait: Trait): Promise<void> {
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

// ─── Public entry: observeResponse ──────────────────────────────────────────

export async function observeResponse(
	env: MiseGraphEnv,
	input: ObserveInput,
): Promise<ObserveResult> {
	const household_id = (input.household_id || "").trim();
	const kind = (input.observation_kind || "").trim();
	if (!household_id) throw new Error("observeResponse: household_id required");
	if (!kind) throw new Error("observeResponse: observation_kind required");

	const observation_text = typeof input.observation_text === "string" ? input.observation_text : "";
	const now = typeof input.now_ms === "number" && Number.isFinite(input.now_ms)
		? input.now_ms
		: Date.now();

	// Resolve the trait deltas: caller-supplied takes priority, else infer.
	const deltas: ObservedTraitDelta[] = (input.inferred_traits && input.inferred_traits.length > 0)
		? input.inferred_traits.filter(d => isKnownTraitName(d.trait_name)).map(d => ({
			trait_name: d.trait_name,
			delta_value: clamp01(d.delta_value),
			delta_confidence: Math.max(0, d.delta_confidence),
		}))
		: inferTraitsFromObservation(kind, observation_text, input.context || {});

	// Apply each delta via Phase A's Bayesian update.
	const applied: TraitDelta[] = [];
	for (const d of deltas) {
		if (!isKnownTraitName(d.trait_name)) continue;
		const existing = await loadTraitRow(env, household_id, d.trait_name);
		const old_value = existing?.trait_value ?? 0.5;
		const old_confidence = existing?.confidence ?? 0;
		const evidence_count = (existing?.evidence_count ?? 0) + 1;
		const updated = applyTraitDelta({
			old_value,
			old_confidence,
			delta_value: d.delta_value,
			delta_confidence: d.delta_confidence,
		});
		try {
			await persistTraitRow(env, {
				household_id,
				trait_name: d.trait_name,
				member_id: input.member_id ?? null,
				trait_value: updated.new_value,
				confidence: updated.new_confidence,
				last_evidence_at_ms: now,
				evidence_count,
			});
		} catch {
			// Trait persistence failure shouldn't break the observation log.
			continue;
		}
		applied.push({
			trait_name: d.trait_name,
			prev_value: round3(old_value),
			prev_confidence: round3(old_confidence),
			new_value: updated.new_value,
			new_confidence: updated.new_confidence,
			delta_value: d.delta_value,
			delta_confidence: d.delta_confidence,
		});
	}

	// Append a synthetic response row so the trait inference engine and the
	// future "what does the agent know about us?" reads see this as evidence.
	const bareKind = kind.startsWith("_observed:") ? kind.slice("_observed:".length) : kind;
	const response_id = makeResponseId(household_id, bareKind, now);
	const question_kind = `_observed:${bareKind}`;
	const question_text = `[observed] ${bareKind}`;
	const response_text = observation_text || bareKind;
	const traitsForLog = applied.map(d => ({
		trait_name: d.trait_name,
		new_value: d.new_value,
		new_confidence: d.new_confidence,
	}));
	try {
		await env.DB.prepare(
			`INSERT OR REPLACE INTO mise_onboarding_responses (${RESPONSE_COLS})
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			response_id,
			household_id,
			input.member_id ?? null,
			question_kind,
			question_text,
			response_text,
			response_text.length,
			now,
			now,
			traitsForLog.length ? JSON.stringify(traitsForLog) : null,
			-1, // tier=-1 marks "not user-asked" so the brief picker can ignore.
		).run();
	} catch {
		// Response log unavailable (table missing) — caller is fine. The
		// trait writes (if any) already landed.
	}

	return {
		recorded: true,
		traits_updated: applied.length,
		deltas: applied,
		response_id,
	};
}

// ─── observeFromTool — fire-and-forget wrapper for write-tool handlers ──────
//
// Called from plan_compose_meal / plan_cancel_meal / plan_swap_ingredient /
// plan_replace_meal handlers AFTER the underlying mutation has succeeded.
// Wraps observeResponse in a try/catch so a logging failure never bubbles
// up and breaks the user-facing planning flow.

export interface ObserveFromToolInput {
	household_id?: string | null;
	plan_id?: string | null;
	observation_kind: ObservationKind;
	observation_text: string;
	member_id?: string;
	context?: ObservationContext;
	inferred_traits?: ReadonlyArray<ObservedTraitDelta>;
}

export async function observeFromTool(
	env: MiseGraphEnv,
	input: ObserveFromToolInput,
): Promise<void> {
	try {
		let household_id = (input.household_id || "").trim();
		if (!household_id && input.plan_id) {
			// Look up the household from the active plan when callers only
			// have plan_id in scope (cancel/swap/replace flows).
			const plan = await loadActivePlan(env, input.plan_id);
			if (plan && typeof plan.household_id === "string") household_id = plan.household_id;
		}
		if (!household_id) return; // No household → silently skip.

		await observeResponse(env, {
			household_id,
			observation_kind: input.observation_kind,
			observation_text: input.observation_text,
			member_id: input.member_id,
			context: input.context,
			inferred_traits: input.inferred_traits,
		});
	} catch {
		// Observation pipeline must NEVER break the calling tool. Swallow.
	}
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0.5;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

function round3(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.round(value * 1000) / 1000;
}

function makeResponseId(household_id: string, kind: string, now: number): string {
	const rand = Math.random().toString(36).slice(2, 8);
	return `obs_${household_id}__${kind}__${now}_${rand}`;
}

// Re-exports for tests and callers that want to introspect the rule table.
export { TRAIT_NAMES };
