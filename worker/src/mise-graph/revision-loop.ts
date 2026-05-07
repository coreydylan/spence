// Revision loop — the LLM-Modulo "compose → audit → revise → polish" core.
//
// This module is the magic sauce. Every other Wave 1 + Wave 2 module
// (resource-ledger, dependency-edges, locks, ripple-preview, critics,
// cascade-proposals) exists to feed this loop. Given a draft plan, we:
//
//   1. Run hard + warning critics → grievances (each carries cascade_proposals).
//   2. Rank grievances (hard before soft, severity-ranked, critic-priority within).
//   3. For each top-K grievance per round, dispatch every cascade proposal into
//      RipplePreview, score each preview, commit the best.
//   4. Re-audit, repeat until converged or budget exhausted.
//   5. Run a deterministic polish pass (cheap local-search moves) — adjacent
//      meal swap is the only one wired today; the others are stubs.
//   6. Return the final plan + a complete audit log.
//
// The implementation is pure and synchronous-friendly: no I/O, no DB, no
// network. The only optional async path is when callers pass
// `composer_env` + `use_llm_for_alternatives: true`, which fetches one
// creative alternative per grievance via the mesh-Claude bridge.
//
// IMPORTANT: this module does NOT mutate its caller's plan. Every reference
// to "plan" inside the loop is on a deep clone we own.

import type { MiseWeeklyPlanDraft, MisePlanMeal } from "./planner";
import type { Grievance, GrievanceSeverity, SlotRef } from "./critics";
import { runHardCritics, runWarningCritics } from "./critics";
import type { CascadeProposal } from "./cascade-proposals";
import { proposalToMutation } from "./cascade-proposals";
import {
	previewCancelMeal,
	previewMoveMeal,
	previewSwapIngredient,
	previewSplitBatch,
	previewReplaceMeal,
	previewMoveShop,
	previewSlidePrepDate,
	commit,
	clearProposalCache,
	type RipplePreview,
	type ReplaceMealNewMeal,
} from "./ripple-preview";
import { isMealLocked } from "./locks";
import type { MeshClaudeEnv } from "./llm-bridge";
import { callMeshClaudeJSON } from "./llm-bridge";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RevisionLoopOptions {
	max_rounds?: number;                    // default 5
	max_grievances_per_round?: number;      // default 3
	composer_env?: MeshClaudeEnv;           // for LLM calls during revise (optional)
	use_llm_for_alternatives?: boolean;     // default false
	polish_passes?: number;                 // default 2
	on_round?: (round: RevisionRound) => void;
}

export interface RevisionAttempt {
	grievance_id: string;
	proposals_considered: CascadeProposal[];
	previews: Array<{ proposal: CascadeProposal; preview: RipplePreview; score: number }>;
	winner?: { proposal: CascadeProposal; preview: RipplePreview };
	committed: boolean;
	reason_skipped?: string;   // "locked" | "no_valid_alternatives" | "negative_net_delta" | "budget" | "unwired_kind"
}

export interface RevisionRound {
	round_number: number;
	before_grievances: Grievance[];
	after_grievances: Grievance[];
	attempts: RevisionAttempt[];
	net_score_delta: number;
	duration_ms: number;
}

export interface PolishMove {
	kind: "swap_meals" | "slide_prep_date" | "hoist_leftover_claim";
	description: string;
	before_score: number;
	after_score: number;
	applied: boolean;
}

export interface RevisionLoopResult {
	final_plan: MiseWeeklyPlanDraft;
	initial_grievances: Grievance[];
	final_grievances: Grievance[];
	rounds: RevisionRound[];
	polish_moves: PolishMove[];
	converged: boolean;
	budget_exhausted: boolean;
	total_duration_ms: number;
	summary: {
		initial_hard: number;
		initial_soft: number;
		final_hard: number;
		final_soft: number;
		rounds_run: number;
		total_attempts: number;
		total_committed: number;
		polish_moves_applied: number;
	};
}

// Critic-priority ordering for tie-breaking inside a severity bucket.
// Lower number = higher priority (tried first).
const CRITIC_PRIORITY: Record<string, number> = {
	WasteCritic: 1,
	ShelfLifeCritic: 2,
	DietaryCritic: 3,
	LeftoverGraphCritic: 4,
	EdgeViolationCritic: 5,
	ResourceContinuityCritic: 6,
	FormulaExistenceCritic: 7,
	ShopFreshnessCritic: 8,
	ShopCoverageCritic: 9,
	FormatCompositionCritic: 10,
	LockStaleCritic: 11,
};

const SEVERITY_RANK: Record<GrievanceSeverity, number> = {
	hard: 0,
	warning: 1,
	preference: 2,
};

const SEVERITY_WEIGHT: Record<GrievanceSeverity, number> = {
	hard: 10,
	warning: 3,
	preference: 1,
};

// ---------------------------------------------------------------------------
// runRevisionLoop — the entry point.
// ---------------------------------------------------------------------------

export async function runRevisionLoop(
	plan: MiseWeeklyPlanDraft,
	options: RevisionLoopOptions = {},
): Promise<RevisionLoopResult> {
	const startedAt = Date.now();
	const max_rounds = options.max_rounds ?? 5;
	const max_grievances_per_round = options.max_grievances_per_round ?? 3;
	const polish_passes = options.polish_passes ?? 2;

	let working = deepClone(plan);
	const initial_grievances = collectAllGrievances(working);

	const rounds: RevisionRound[] = [];
	let budget_exhausted = false;
	let stuck_rounds = 0;          // counts consecutive zero-progress rounds
	let last_soft_count = countSeverity(initial_grievances, "warning");

	for (let r = 0; r < max_rounds; r++) {
		const roundStarted = Date.now();
		const before_grievances = collectAllGrievances(working);
		const before_hard = countSeverity(before_grievances, "hard");
		const before_soft = countSeverity(before_grievances, "warning");

		const ranked = rankGrievances(before_grievances);
		const top = ranked.slice(0, max_grievances_per_round);

		const attempts: RevisionAttempt[] = [];
		let any_committed = false;
		let round_score_delta = 0;

		for (const g of top) {
			const attempt = await tryFixGrievance(working, g, options);
			attempts.push(attempt);
			if (attempt.committed && attempt.winner) {
				working = attempt.winner.preview.preview_state!.plan;
				any_committed = true;
				round_score_delta += attempt.winner.preview.scores.net_delta;
			}
		}

		const after_grievances = collectAllGrievances(working);
		const after_hard = countSeverity(after_grievances, "hard");
		const after_soft = countSeverity(after_grievances, "warning");

		const round: RevisionRound = {
			round_number: r + 1,
			before_grievances,
			after_grievances,
			attempts,
			net_score_delta: round_score_delta,
			duration_ms: Date.now() - roundStarted,
		};
		rounds.push(round);
		try { options.on_round?.(round); } catch { /* observer must not break the loop */ }

		// --- convergence/exit logic ----------------------------------------
		// Hard count dropped to 0 — and soft count didn't grow over the last
		// 2 rounds — call it converged.
		if (after_hard === 0) {
			if (after_soft <= last_soft_count) {
				stuck_rounds++;
			} else {
				stuck_rounds = 0;
			}
			if (stuck_rounds >= 2) break;
		}
		last_soft_count = after_soft;

		// No commits AND no improvement in either dimension → stuck. Bail.
		const improvement = (before_hard - after_hard) + Math.max(0, before_soft - after_soft);
		if (!any_committed && improvement <= 0) {
			// One last chance: if the next round can't possibly do better, exit.
			break;
		}
	}

	if (rounds.length >= max_rounds) {
		const final = collectAllGrievances(working);
		if (countSeverity(final, "hard") > 0) budget_exhausted = true;
	}

	// --- Polish pass --------------------------------------------------------
	const polish_moves: PolishMove[] = [];
	for (let p = 0; p < polish_passes; p++) {
		const moves = runPolishPass(working);
		if (moves.length === 0) break;
		// Apply any improving moves; record them.
		let any_applied = false;
		for (const m of moves) {
			if (m.applied) {
				any_applied = true;
				working = m.resulting_plan!;
			}
			polish_moves.push(stripInternal(m));
		}
		if (!any_applied) break;
	}

	const final_grievances = collectAllGrievances(working);
	const final_hard = countSeverity(final_grievances, "hard");
	const final_soft = countSeverity(final_grievances, "warning");
	const initial_hard = countSeverity(initial_grievances, "hard");
	const initial_soft = countSeverity(initial_grievances, "warning");

	const total_attempts = rounds.reduce((acc, r) => acc + r.attempts.length, 0);
	const total_committed = rounds.reduce((acc, r) => acc + r.attempts.filter(a => a.committed).length, 0);
	const polish_moves_applied = polish_moves.filter(m => m.applied).length;

	const converged = final_hard === 0;

	return {
		final_plan: working,
		initial_grievances,
		final_grievances,
		rounds,
		polish_moves,
		converged,
		budget_exhausted,
		total_duration_ms: Date.now() - startedAt,
		summary: {
			initial_hard,
			initial_soft,
			final_hard,
			final_soft,
			rounds_run: rounds.length,
			total_attempts,
			total_committed,
			polish_moves_applied,
		},
	};
}

// ---------------------------------------------------------------------------
// tryFixGrievance — dispatch every cascade proposal to RipplePreview, score,
// commit the best one (if any has positive net_delta).
// ---------------------------------------------------------------------------

export async function tryFixGrievance(
	plan: MiseWeeklyPlanDraft,
	grievance: Grievance,
	options: RevisionLoopOptions = {},
): Promise<RevisionAttempt> {
	// Clear the in-memory proposal cache so we don't accidentally commit a
	// stale proposal_id from an earlier preview pass.
	clearProposalCache();

	const grievance_id = fingerprint(grievance);
	const proposals = grievance.cascade_proposals || [];

	if (proposals.length === 0) {
		return {
			grievance_id,
			proposals_considered: [],
			previews: [],
			committed: false,
			reason_skipped: "no_valid_alternatives",
		};
	}

	const previews: Array<{ proposal: CascadeProposal; preview: RipplePreview; score: number }> = [];
	let saw_locked = false;
	let saw_unwired = false;

	for (const p of proposals) {
		const mutation = proposalToMutation(p);
		if (!mutation) continue;
		const preview = dispatchToPreview(plan, mutation);
		if (!preview) {
			saw_unwired = true;
			continue;
		}
		const lockedWarning = preview.warnings.some(w => /locked/i.test(w));
		if (lockedWarning) {
			saw_locked = true;
			// Still record it in the audit log so the user sees the proposal
			// was tried and rejected because of a lock.
			previews.push({ proposal: p, preview, score: 0 });
			continue;
		}
		const unwiredWarning = preview.warnings.some(w => /not yet wired/i.test(w));
		if (unwiredWarning) {
			saw_unwired = true;
			previews.push({ proposal: p, preview, score: 0 });
			continue;
		}
		const score = computeScore(preview, grievance);
		previews.push({ proposal: p, preview, score });
	}

	// Optional LLM augmentation.
	if (options.use_llm_for_alternatives && options.composer_env) {
		try {
			const llmAlt = await proposeLlmAlternative(plan, grievance, options.composer_env);
			if (llmAlt) {
				const mutation = proposalToMutation(llmAlt);
				if (mutation) {
					const preview = dispatchToPreview(plan, mutation);
					if (preview && !preview.warnings.some(w => /locked/i.test(w))) {
						const score = computeScore(preview, grievance);
						previews.push({ proposal: llmAlt, preview, score });
					}
				}
			}
		} catch {
			// LLM augmentation is opportunistic; never let it break the loop.
		}
	}

	// Pick winner.
	previews.sort((a, b) => b.score - a.score);
	const winner = previews.find(p => p.score > 0);

	if (!winner) {
		// What's the most informative skip reason?
		let reason: RevisionAttempt["reason_skipped"] = "negative_net_delta";
		if (previews.length === 0) {
			if (saw_locked) reason = "locked";
			else if (saw_unwired) reason = "unwired_kind";
			else reason = "no_valid_alternatives";
		}
		return {
			grievance_id,
			proposals_considered: proposals,
			previews,
			committed: false,
			reason_skipped: reason,
		};
	}

	// Commit the winner via RipplePreview's commit API. The preview already
	// holds preview_state.plan, so commit returns a deep-cloned post-state.
	let committed_plan: MiseWeeklyPlanDraft;
	try {
		committed_plan = commit(plan, winner.preview.proposal_id);
	} catch {
		// Cache may have been cleared between dispatch and commit. Fall back
		// to using the preview's preview_state directly.
		committed_plan = winner.preview.preview_state
			? deepClone(winner.preview.preview_state.plan)
			: deepClone(plan);
	}

	// Substitute the committed plan into the winner's preview_state so the
	// caller can advance `working = winner.preview.preview_state.plan`.
	const winner_with_committed: { proposal: CascadeProposal; preview: RipplePreview } = {
		proposal: winner.proposal,
		preview: { ...winner.preview, preview_state: { plan: committed_plan } },
	};

	return {
		grievance_id,
		proposals_considered: proposals,
		previews,
		winner: winner_with_committed,
		committed: true,
	};
}

// ---------------------------------------------------------------------------
// dispatchToPreview — route a mutation blob into the right RipplePreview fn.
//
// For kinds RipplePreview doesn't yet support, returns a "spec_pending"
// stub preview: empty deltas, score 0, warnings flagging the unwired kind.
// The revision loop treats those as no-ops and tries the next proposal,
// while still surfacing them in the audit log.
// ---------------------------------------------------------------------------

const UNWIRED_MUTATION_KINDS = new Set([
	"merge_batches",
	"drop_item_from_shop",
	"add_shop",
	"add_meal",
	"substitute_recipe",
	"lock_slot",
]);

export function dispatchToPreview(
	plan: MiseWeeklyPlanDraft,
	mutation: { kind: string;[key: string]: unknown },
): RipplePreview | null {
	const kind = mutation.kind;
	switch (kind) {
		case "swap_ingredient": {
			const slot = coerceSlot(mutation.slot);
			const from = String(mutation.from_name ?? "");
			const to = String(mutation.to_name ?? "");
			if (!slot || !from) return makeSpecPendingPreview(mutation, "swap_ingredient missing slot/from_name");
			// Special case: critics emit swap_ingredient with field="leftovers_to"
			// to drop a dangling/backward leftover claim. RipplePreview's
			// previewSwapIngredient only edits raw_ingredients today, so we
			// build a minimal local preview that strips the claim and runs
			// critics on the post-state.
			if (mutation.field === "leftovers_to") {
				return previewLeftoverClaimDrop(plan, slot, from);
			}
			return previewSwapIngredient(plan, slot, from, to);
		}
		case "cancel_meal": {
			const slot = coerceSlot(mutation.slot);
			if (!slot) return makeSpecPendingPreview(mutation, "cancel_meal missing slot");
			return previewCancelMeal(plan, slot);
		}
		case "move_meal": {
			// cascade-proposals serialises move_meal with from_slot/to_slot;
			// RipplePreview's previewMoveMeal expects from/to. Accept both.
			const from = coerceSlot(mutation.from_slot ?? mutation.from);
			const to = coerceSlot(mutation.to_slot ?? mutation.to);
			if (!from || !to) return makeSpecPendingPreview(mutation, "move_meal missing from/to slot");
			return previewMoveMeal(plan, from, to);
		}
		case "split_batch": {
			const batch_id = typeof mutation.batch_id === "string" ? mutation.batch_id : "";
			// cascade-proposals serialises with `split_at_date`; ripple-preview takes `at_date`.
			const at_date_raw = mutation.at_date ?? mutation.split_at_date;
			const at_date = typeof at_date_raw === "string" ? at_date_raw : "";
			if (!batch_id || !at_date) return makeSpecPendingPreview(mutation, "split_batch missing batch_id/at_date");
			return previewSplitBatch(plan, batch_id, at_date);
		}
		case "replace_meal": {
			const slot = coerceSlot(mutation.slot);
			if (!slot) return makeSpecPendingPreview(mutation, "replace_meal missing slot");
			const new_meal = coerceReplaceMealBody(mutation.new_meal);
			const must_consume = Array.isArray(mutation.must_consume) ? mutation.must_consume.map(String) : undefined;
			const must_avoid = Array.isArray(mutation.must_avoid) ? mutation.must_avoid.map(String) : undefined;
			return previewReplaceMeal(plan, slot, new_meal, { must_consume, must_avoid });
		}
		case "move_shop": {
			const run_id = typeof mutation.run_id === "string" ? mutation.run_id : "";
			const new_date = typeof mutation.new_date === "string" ? mutation.new_date : "";
			if (!run_id || !new_date) return makeSpecPendingPreview(mutation, "move_shop missing run_id/new_date");
			return previewMoveShop(plan, run_id, new_date);
		}
		case "slide_prep_date": {
			const batch_id = typeof mutation.batch_id === "string" ? mutation.batch_id : "";
			const new_prep_date = typeof mutation.new_prep_date === "string" ? mutation.new_prep_date : "";
			if (!batch_id || !new_prep_date) return makeSpecPendingPreview(mutation, "slide_prep_date missing batch_id/new_prep_date");
			return previewSlidePrepDate(plan, batch_id, new_prep_date);
		}
		default: {
			if (UNWIRED_MUTATION_KINDS.has(kind)) {
				return makeSpecPendingPreview(mutation, `mutation kind ${kind} not yet wired`);
			}
			return null;
		}
	}
}

// Local helper for swap_ingredient field="leftovers_to" — drops a leftover
// claim from a meal and produces a RipplePreview-shaped result. We avoid
// modifying ripple-preview.ts (owned by Agent F) by computing the diff in
// terms of grievances and an empty deltas surface.
function previewLeftoverClaimDrop(
	plan: MiseWeeklyPlanDraft,
	slot: { date: string; slot: string },
	claim: string,
): RipplePreview {
	const post = deepClone(plan);
	const slotL = (slot.slot || "").toLowerCase();
	let touched = false;
	for (const day of post.meals_by_day || []) {
		if (day.date !== slot.date) continue;
		for (const meal of day.meals) {
			if (meal.slot.toLowerCase() !== slotL) continue;
			const before = meal.leftovers_to || [];
			const after = before.filter(c => c.toLowerCase().trim() !== claim.toLowerCase().trim());
			if (after.length !== before.length) {
				meal.leftovers_to = after;
				touched = true;
			}
		}
	}
	if (!touched) {
		return makeSpecPendingPreview(
			{ kind: "swap_ingredient" },
			`leftovers_to claim "${claim}" not found at ${slot.date} ${slot.slot}`,
		);
	}

	const preGriev = collectAllGrievances(plan);
	const postGriev = collectAllGrievances(post);
	const { newGrievances, resolvedGrievances } = diffGrievanceLists(preGriev, postGriev);

	const proposal_id = `local_drop_leftover_${Math.random().toString(36).slice(2, 10)}`;
	const preview: RipplePreview = {
		proposed_change: {
			kind: "swap_ingredient",
			slot,
			from_name: claim,
			to_name: "",
		} as RipplePreview["proposed_change"],
		affected_meals: [{
			meal_id: findMealForSlot(post, slot)?.id || "?",
			date: slot.date,
			slot: slot.slot,
			change: "modified",
			detail: `dropped leftover claim "${claim}"`,
		}],
		affected_batches: [],
		affected_prep_tasks: [],
		affected_shopping: { added: [], removed: [], qty_changed: [], runs_changed: [] },
		affected_edges: { added: [], removed: [], status_changed: [] },
		new_grievances: newGrievances,
		resolved_grievances: resolvedGrievances,
		scores: {
			waste_delta: 0,
			variety_delta: 0,
			effort_delta: 0,
			reuse_delta: 0,
			net_delta: resolvedGrievances.length > 0 ? 1 : 0,
		},
		cascade_proposals: [],
		reversible: true,
		warnings: [],
		proposal_id,
		preview_state: { plan: post },
	};
	return preview;
}

function diffGrievanceLists(pre: Grievance[], post: Grievance[]): { newGrievances: Grievance[]; resolvedGrievances: Grievance[] } {
	const keyOf = (g: Grievance): string => {
		const slot = g.slot_ref ? `${g.slot_ref.date}::${g.slot_ref.slot}` : "";
		const batch = g.batch_id || "";
		const prefix = (g.message || "").slice(0, 80);
		return `${g.critic}|${slot}|${batch}|${prefix}`;
	};
	const preKeys = new Map(pre.map(g => [keyOf(g), g]));
	const postKeys = new Map(post.map(g => [keyOf(g), g]));
	const newGrievances: Grievance[] = [];
	const resolvedGrievances: Grievance[] = [];
	for (const [k, g] of postKeys) if (!preKeys.has(k)) newGrievances.push(g);
	for (const [k, g] of preKeys) if (!postKeys.has(k)) resolvedGrievances.push(g);
	return { newGrievances, resolvedGrievances };
}

function makeSpecPendingPreview(mutation: { kind: string;[key: string]: unknown }, reason: string): RipplePreview {
	// Build a minimal RipplePreview-shaped stub. The loop checks for either
	// score 0 (skipped under negative_net_delta) or warnings containing
	// "not yet wired" (skipped as unwired_kind) — either path keeps the
	// proposal in the audit log without committing it.
	return {
		proposed_change: { kind: "cancel_meal", slot: { date: "", slot: "" } } as unknown as RipplePreview["proposed_change"],
		affected_meals: [],
		affected_batches: [],
		affected_prep_tasks: [],
		affected_shopping: { added: [], removed: [], qty_changed: [], runs_changed: [] },
		affected_edges: { added: [], removed: [], status_changed: [] },
		new_grievances: [],
		resolved_grievances: [],
		scores: { waste_delta: 0, variety_delta: 0, effort_delta: 0, reuse_delta: 0, net_delta: 0 },
		cascade_proposals: [],
		reversible: false,
		warnings: [reason],
		proposal_id: `spec_pending_${mutation.kind}_${Math.random().toString(36).slice(2, 10)}`,
	};
}

function coerceSlot(value: unknown): { date: string; slot: string } | null {
	if (!value || typeof value !== "object") return null;
	const v = value as { date?: unknown; slot?: unknown };
	if (typeof v.date !== "string" || typeof v.slot !== "string") return null;
	if (!v.date || !v.slot) return null;
	return { date: v.date, slot: v.slot };
}

function coerceReplaceMealBody(value: unknown): ReplaceMealNewMeal | undefined {
	if (!value || typeof value !== "object") return undefined;
	const v = value as Record<string, unknown>;
	const out: ReplaceMealNewMeal = {};
	if (typeof v.title === "string") out.title = v.title;
	if (typeof v.format === "string") out.format = v.format;
	if (Array.isArray(v.cuisine)) out.cuisine = v.cuisine.filter((s): s is string => typeof s === "string");
	if (typeof v.method_summary === "string") out.method_summary = v.method_summary;
	if (Array.isArray(v.formula_ids)) out.formula_ids = v.formula_ids.filter((s): s is string => typeof s === "string");
	if (Array.isArray(v.leftovers_to)) out.leftovers_to = v.leftovers_to.filter((s): s is string => typeof s === "string");
	if (Array.isArray(v.raw_ingredients)) {
		out.raw_ingredients = v.raw_ingredients
			.filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
			.map(r => ({
				name: typeof r.name === "string" ? r.name : "",
				qty: typeof r.qty === "number" ? r.qty : undefined,
				unit: typeof r.unit === "string" ? r.unit : undefined,
				grams: typeof r.grams === "number" ? r.grams : undefined,
			}))
			.filter(r => !!r.name);
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// rankGrievances — hard before warning, then by critic-priority.
// ---------------------------------------------------------------------------

export function rankGrievances(grievances: Grievance[]): Grievance[] {
	return grievances.slice().sort((a, b) => {
		const ra = SEVERITY_RANK[a.severity] ?? 99;
		const rb = SEVERITY_RANK[b.severity] ?? 99;
		if (ra !== rb) return ra - rb;
		const pa = CRITIC_PRIORITY[a.critic] ?? 99;
		const pb = CRITIC_PRIORITY[b.critic] ?? 99;
		if (pa !== pb) return pa - pb;
		// Stable tie-break on slot date.
		const da = a.slot_ref?.date || "";
		const db = b.slot_ref?.date || "";
		return da.localeCompare(db);
	});
}

// ---------------------------------------------------------------------------
// computeScore — bias the loop toward fixing hard issues without creating
// new ones. Composes RipplePreview.scores.net_delta with bonuses/penalties
// pinned to the current grievance.
// ---------------------------------------------------------------------------

export function computeScore(preview: RipplePreview, grievance: Grievance): number {
	let score = preview.scores.net_delta;

	// Bonus: the preview resolved any grievance from the SAME critic and slot
	// as the one we're trying to fix. We can't compare grievance IDs directly
	// because different parts of the codebase fingerprint differently — match
	// on (critic, slot_ref) which is more durable.
	const targetCritic = grievance.critic;
	const targetSlot = grievance.slot_ref ? `${grievance.slot_ref.date}::${grievance.slot_ref.slot}` : "";
	const resolvedTarget = preview.resolved_grievances.some(rg => {
		if (rg.critic !== targetCritic) return false;
		const rgSlot = rg.slot_ref ? `${rg.slot_ref.date}::${rg.slot_ref.slot}` : "";
		return !targetSlot || !rgSlot ? true : rgSlot === targetSlot;
	});
	if (resolvedTarget) {
		score += SEVERITY_WEIGHT[grievance.severity];
	}

	// Penalty: every NEW hard grievance the preview introduces.
	for (const ng of preview.new_grievances) {
		if (ng.severity === "hard") score -= 15;
	}

	return score;
}

// ---------------------------------------------------------------------------
// LLM augmentation — fetch one creative alternative the deterministic
// generators wouldn't produce. Best-effort: caller should expect failures.
// ---------------------------------------------------------------------------

interface LlmAltResponse {
	kind?: string;
	description?: string;
	parameters?: Record<string, unknown>;
	confidence?: number;
}

async function proposeLlmAlternative(
	plan: MiseWeeklyPlanDraft,
	grievance: Grievance,
	env: MeshClaudeEnv,
): Promise<CascadeProposal | null> {
	const slot = grievance.slot_ref;
	if (!slot) return null;
	const meal = findMealForSlot(plan, slot);
	const ledger_summary = summarizeLedger(plan);

	const prompt = [
		`Grievance: ${grievance.message}`,
		grievance.suggested_repair ? `Suggested repair: ${grievance.suggested_repair}` : "",
		meal ? `Current meal: ${meal.title} (${meal.format}).` : "",
		`Slot: ${slot.date} ${slot.slot}.`,
		`Ledger snapshot: ${ledger_summary}`,
		"",
		"Suggest ONE alternative cascade proposal that has not already been tried.",
		"Return JSON: {kind: 'swap_ingredient'|'cancel_meal'|'move_meal', description: string, parameters: object, confidence: number}.",
	].filter(Boolean).join("\n");

	const { ok, data } = await callMeshClaudeJSON<LlmAltResponse>(env, { prompt });
	if (!ok || !data || typeof data.kind !== "string") return null;

	const cleanedKind = data.kind;
	if (!["swap_ingredient", "cancel_meal", "move_meal"].includes(cleanedKind)) return null;

	const proposal: CascadeProposal = {
		kind: cleanedKind as CascadeProposal["kind"],
		description: data.description || "LLM-proposed alternative",
		expected_resolves: [fingerprint(grievance)],
		parameters: data.parameters || {},
		confidence: typeof data.confidence === "number" ? data.confidence : 0.5,
	};
	return proposal;
}

function findMealForSlot(plan: MiseWeeklyPlanDraft, slot: SlotRef): MisePlanMeal | undefined {
	const slotL = (slot.slot || "").toLowerCase();
	for (const day of plan.meals_by_day || []) {
		if (day.date !== slot.date) continue;
		for (const m of day.meals) {
			if (m.slot.toLowerCase() === slotL) return m;
		}
	}
	if (slotL === "breakfast") {
		for (const m of plan.breakfasts || []) if (m.date === slot.date) return m;
	}
	return undefined;
}

function summarizeLedger(plan: MiseWeeklyPlanDraft): string {
	const batches = plan.component_batches || [];
	if (batches.length === 0) return "no batches";
	return batches.map(b => `${b.label} (uses=${(b.planned_uses || []).length})`).slice(0, 6).join("; ");
}

// ---------------------------------------------------------------------------
// Polish pass — deterministic local-search moves the LLM doesn't need.
// ---------------------------------------------------------------------------

interface PolishMoveInternal extends PolishMove {
	resulting_plan?: MiseWeeklyPlanDraft;
}

function runPolishPass(plan: MiseWeeklyPlanDraft): PolishMoveInternal[] {
	const out: PolishMoveInternal[] = [];

	// 1. Adjacent meal swap (the only kind wired in v1).
	const dinnerSlots = collectDinnerSlots(plan);
	for (let i = 0; i < dinnerSlots.length - 1; i++) {
		const a = dinnerSlots[i];
		const b = dinnerSlots[i + 1];
		if (isMealLocked(a.meal) || isMealLocked(b.meal)) continue;

		const before_score = scorePlan(plan);
		// Swap a and b in a clone, re-score.
		const swapped = swapTwoDinners(plan, a.meal, b.meal);
		if (!swapped) continue;
		const after_score = scorePlan(swapped);
		const improves = after_score > before_score;
		out.push({
			kind: "swap_meals",
			description: `Swap dinners on ${a.meal.date} and ${b.meal.date} ("${a.meal.title}" ↔ "${b.meal.title}").`,
			before_score,
			after_score,
			applied: improves,
			resulting_plan: improves ? swapped : undefined,
		});
		if (improves) {
			// Stop after the first improving move so we re-evaluate a fresh state
			// in the next polish pass. This matches the LLM-Modulo paper's
			// hill-climbing protocol.
			return out;
		}
	}

	// TODO(polish-v2): slide_prep_date — for each batch with desired_prep_date,
	// try ±1 day and keep the move that reduces variance of total active_time
	// per day.

	// TODO(polish-v2): hoist_leftover_claim — if a dinner's leftovers_to claim
	// points at an empty slot, try moving the claim to the next-later empty
	// slot to extend shelf use.

	return out;
}

interface DinnerSlot {
	day_index: number;
	meal: MisePlanMeal;
}

function collectDinnerSlots(plan: MiseWeeklyPlanDraft): DinnerSlot[] {
	const out: DinnerSlot[] = [];
	const sortedDays = (plan.meals_by_day || []).slice().sort((a, b) => a.date.localeCompare(b.date));
	for (let i = 0; i < sortedDays.length; i++) {
		for (const m of sortedDays[i].meals) {
			if (m.slot.toLowerCase() === "dinner") {
				out.push({ day_index: i, meal: m });
				break;
			}
		}
	}
	return out;
}

function swapTwoDinners(plan: MiseWeeklyPlanDraft, a: MisePlanMeal, b: MisePlanMeal): MiseWeeklyPlanDraft | null {
	const cloned = deepClone(plan);
	const dayA = (cloned.meals_by_day || []).find(d => d.date === a.date);
	const dayB = (cloned.meals_by_day || []).find(d => d.date === b.date);
	if (!dayA || !dayB) return null;

	const idxA = dayA.meals.findIndex(m => m.id === a.id);
	const idxB = dayB.meals.findIndex(m => m.id === b.id);
	if (idxA < 0 || idxB < 0) return null;

	// Swap the meal objects, updating their date fields.
	const fromA = dayA.meals[idxA];
	const fromB = dayB.meals[idxB];
	const movedA: MisePlanMeal = { ...fromA, date: b.date };
	const movedB: MisePlanMeal = { ...fromB, date: a.date };
	dayA.meals[idxA] = movedB;
	dayB.meals[idxB] = movedA;

	// Walk batch planned_uses to follow the meals.
	for (const batch of cloned.component_batches || []) {
		batch.planned_uses = (batch.planned_uses || []).map(u => {
			if (u.meal_id === fromA.id && u.date === a.date) return { ...u, date: b.date };
			if (u.meal_id === fromB.id && u.date === b.date) return { ...u, date: a.date };
			return u;
		});
	}
	return cloned;
}

// scorePlan — a tiny deterministic plan-quality heuristic the polish pass
// can hill-climb against. Lower waste + fewer hard grievances is better.
// We deliberately don't reuse RipplePreview's scoring here because we want
// an absolute score, not a delta.
function scorePlan(plan: MiseWeeklyPlanDraft): number {
	let score = 0;
	const grievances = collectAllGrievances(plan);
	for (const g of grievances) {
		score -= SEVERITY_WEIGHT[g.severity];
	}
	// Reward batches that have any planned use.
	for (const b of plan.component_batches || []) {
		const uses = (b.planned_uses || []).length;
		if (uses > 0) score += 1;
		else score -= 2;        // penalty for orphan batch
	}
	return score;
}

function stripInternal(m: PolishMoveInternal): PolishMove {
	const { resulting_plan: _ignored, ...rest } = m;
	return rest;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectAllGrievances(plan: MiseWeeklyPlanDraft): Grievance[] {
	const out: Grievance[] = [];
	try { out.push(...runHardCritics(plan)); } catch { /* ignore */ }
	try { out.push(...runWarningCritics(plan)); } catch { /* ignore */ }
	return out;
}

function countSeverity(grievances: Grievance[], sev: GrievanceSeverity): number {
	let n = 0;
	for (const g of grievances) if (g.severity === sev) n++;
	return n;
}

function fingerprint(g: Grievance): string {
	const slot = g.slot_ref ? `${g.slot_ref.date}/${g.slot_ref.slot}` : "-";
	const prefix = (g.message || "").slice(0, 40);
	return `${g.critic}|${slot}|${prefix}`;
}

function deepClone<T>(value: T): T {
	if (typeof structuredClone === "function") return structuredClone(value);
	return JSON.parse(JSON.stringify(value)) as T;
}
