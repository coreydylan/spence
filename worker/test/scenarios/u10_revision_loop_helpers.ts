// U10 — Revision-loop helper unit tests.
//
// Pure unit tests for `rankGrievances`, `dispatchToPreview`, `computeScore`,
// and the no-cascade-proposals fast-path inside `tryFixGrievance`. These
// guard the contracts the integration test (t07) relies on.

import type { Scenario } from "../lib/types";
import type { Grievance } from "../../src/mise-graph/critics";
import type { CascadeProposal } from "../../src/mise-graph/cascade-proposals";
import type { MiseWeeklyPlanDraft, MisePlanMeal } from "../../src/mise-graph/planner";
import type { RipplePreview } from "../../src/mise-graph/ripple-preview";
import {
	rankGrievances,
	dispatchToPreview,
	computeScore,
	tryFixGrievance,
} from "../../src/mise-graph/revision-loop";
import { clearProposalCache } from "../../src/mise-graph/ripple-preview";

const u10: Scenario = {
	id: "u10",
	name: "revision-loop helpers: rank, dispatch, score, no-proposals fast path",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// --- rankGrievances ----------------------------------------------------
		const a: Grievance = { critic: "ShopFreshnessCritic", severity: "warning", message: "soft thing" };
		const b: Grievance = { critic: "WasteCritic", severity: "hard", message: "waste hard" };
		const c: Grievance = { critic: "ShelfLifeCritic", severity: "hard", message: "shelf hard" };
		const d: Grievance = { critic: "DietaryCritic", severity: "hard", message: "diet hard" };
		const e: Grievance = { critic: "LockStaleCritic", severity: "warning", message: "stale lock" };
		const ranked = rankGrievances([a, b, c, d, e]);
		ctx.assert.eq(ranked[0].critic, "WasteCritic", "WasteCritic outranks all others");
		ctx.assert.eq(ranked[1].critic, "ShelfLifeCritic", "ShelfLife is second");
		ctx.assert.eq(ranked[2].critic, "DietaryCritic", "Dietary is third");
		// All three hard come before any warning.
		ctx.assert.eq(ranked[3].severity, "warning", "all hard before any warning");
		ctx.assert.eq(ranked[4].severity, "warning", "second warning is last");

		// --- dispatchToPreview routes correctly --------------------------------
		clearProposalCache();
		const plan = makePlan();

		// swap_ingredient: routes to previewSwapIngredient and yields a real preview.
		const swapPreview = dispatchToPreview(plan, {
			kind: "swap_ingredient",
			slot: { date: "2026-05-12", slot: "dinner" },
			from_name: "salmon",
			to_name: "tofu",
		});
		ctx.assert.ok(!!swapPreview, "swap_ingredient routes to a preview");
		ctx.assert.ok(!!swapPreview!.proposal_id, "swap preview has a proposal_id");

		// cancel_meal: routes to previewCancelMeal.
		const cancelPreview = dispatchToPreview(plan, {
			kind: "cancel_meal",
			slot: { date: "2026-05-12", slot: "dinner" },
		});
		ctx.assert.ok(!!cancelPreview, "cancel_meal routes to a preview");

		// move_meal: accepts both from_slot/to_slot AND from/to shapes.
		const moveViaSlot = dispatchToPreview(plan, {
			kind: "move_meal",
			from_slot: { date: "2026-05-12", slot: "dinner" },
			to_slot: { date: "2026-05-13", slot: "dinner" },
		});
		ctx.assert.ok(!!moveViaSlot, "move_meal accepts from_slot/to_slot shape");

		// split_batch is wired — for a non-existent batch it returns a no-op
		// preview with a "batch not found" warning instead of a spec_pending stub.
		const splitPreview = dispatchToPreview(plan, { kind: "split_batch", batch_id: "x", at_date: "2026-05-15" });
		ctx.assert.ok(!!splitPreview, "split_batch returns a preview (not null)");
		ctx.assert.ok(splitPreview!.warnings.some(w => /batch not found/i.test(w)), "missing-batch split returns a 'batch not found' warning");
		ctx.assert.eq(splitPreview!.scores.net_delta, 0, "no-op preview has zero score");

		// Truly unwired kinds (e.g. merge_batches) still return a spec_pending stub.
		const mergePreview = dispatchToPreview(plan, { kind: "merge_batches", batch_ids: ["a", "b"] });
		ctx.assert.ok(!!mergePreview, "merge_batches returns a spec_pending stub (not null)");
		ctx.assert.ok(mergePreview!.warnings.some(w => /not yet wired/i.test(w)), "spec_pending preview carries 'not yet wired' warning");

		// --- computeScore: hard-resolution beats soft-resolution ---------------
		const baseScores = { waste_delta: 0, variety_delta: 0, effort_delta: 0, reuse_delta: 0, net_delta: 1 };
		const hardGrievance: Grievance = {
			critic: "DietaryCritic",
			severity: "hard",
			slot_ref: { date: "2026-05-12", slot: "dinner" },
			message: "diet violation",
		};
		const softGrievance: Grievance = {
			critic: "LockStaleCritic",
			severity: "warning",
			slot_ref: { date: "2026-05-12", slot: "dinner" },
			message: "stale lock",
		};
		const previewResolvesHard: RipplePreview = makeFakePreview({
			scores: baseScores,
			resolved: [hardGrievance],
			added: [],
		});
		const previewResolvesSoft: RipplePreview = makeFakePreview({
			scores: baseScores,
			resolved: [softGrievance],
			added: [],
		});
		const hardScore = computeScore(previewResolvesHard, hardGrievance);
		const softScore = computeScore(previewResolvesSoft, softGrievance);
		ctx.assert.gt(hardScore, softScore, "resolving a hard grievance yields a higher score than resolving a soft one");

		// New hard grievance penalty.
		const previewIntroducesHard: RipplePreview = makeFakePreview({
			scores: baseScores,
			resolved: [hardGrievance],
			added: [{ ...hardGrievance, message: "fresh hard problem", slot_ref: { date: "2026-05-13", slot: "dinner" } }],
		});
		const penalized = computeScore(previewIntroducesHard, hardGrievance);
		ctx.assert.ok(penalized < hardScore, "introducing a new hard grievance penalizes the score");

		// --- tryFixGrievance fast paths ---------------------------------------
		clearProposalCache();
		const orphanGrievance: Grievance = {
			critic: "DietaryCritic",
			severity: "hard",
			message: "no proposals",
			slot_ref: { date: "2026-05-12", slot: "dinner" },
			cascade_proposals: [],
		};
		const orphanAttempt = await tryFixGrievance(plan, orphanGrievance);
		ctx.assert.eq(orphanAttempt.committed, false, "no proposals → not committed");
		ctx.assert.eq(orphanAttempt.reason_skipped, "no_valid_alternatives", "no proposals → reason no_valid_alternatives");

		// Grievance whose only proposal is an unwired kind.
		clearProposalCache();
		const unwiredOnly: Grievance = {
			critic: "ShelfLifeCritic",
			severity: "hard",
			message: "shelf life violated",
			slot_ref: { date: "2026-05-12", slot: "dinner" },
			cascade_proposals: [
				{
					kind: "merge_batches",
					description: "merge two batches",
					expected_resolves: ["g1"],
					parameters: { batch_ids: ["b_x", "b_y"] },
					mutation: { kind: "merge_batches", batch_ids: ["b_x", "b_y"] },
					confidence: 0.8,
				},
			],
		};
		const unwiredAttempt = await tryFixGrievance(plan, unwiredOnly);
		ctx.assert.eq(unwiredAttempt.committed, false, "only unwired proposal → not committed");
		ctx.assert.eq(unwiredAttempt.previews.length, 1, "spec_pending preview is still recorded in the audit log");

		// Grievance with a wired proposal that actually resolves something.
		clearProposalCache();
		const fixable: Grievance = {
			critic: "DietaryCritic",
			severity: "hard",
			message: "fish sauce in vegetarian",
			slot_ref: { date: "2026-05-12", slot: "dinner" },
			cascade_proposals: [
				{
					kind: "swap_ingredient",
					description: "swap salmon for tofu",
					expected_resolves: ["g1"],
					parameters: { slot: { date: "2026-05-12", slot: "dinner" }, from_name: "salmon", to_name: "tofu" },
					mutation: { kind: "swap_ingredient", slot: { date: "2026-05-12", slot: "dinner" }, from_name: "salmon", to_name: "tofu" },
					confidence: 0.8,
				},
			],
		};
		const fixedAttempt = await tryFixGrievance(plan, fixable);
		ctx.assert.eq(fixedAttempt.committed, true, "wired proposal that resolves the grievance is committed");
		ctx.assert.ok(!!fixedAttempt.winner, "winner is set when commit succeeds");
		ctx.assert.eq(fixedAttempt.winner!.proposal.kind, "swap_ingredient", "winner is the swap_ingredient proposal");
	},
};

function makeFakePreview(input: {
	scores: RipplePreview["scores"];
	resolved: import("../../src/mise-graph/critics").Grievance[];
	added: import("../../src/mise-graph/critics").Grievance[];
}): RipplePreview {
	return {
		proposed_change: { kind: "cancel_meal", slot: { date: "x", slot: "x" } } as RipplePreview["proposed_change"],
		affected_meals: [],
		affected_batches: [],
		affected_prep_tasks: [],
		affected_shopping: { added: [], removed: [], qty_changed: [], runs_changed: [] },
		affected_edges: { added: [], removed: [], status_changed: [] },
		new_grievances: input.added,
		resolved_grievances: input.resolved,
		scores: input.scores,
		cascade_proposals: [],
		reversible: true,
		warnings: [],
		proposal_id: `fake_${Math.random().toString(36).slice(2, 8)}`,
	};
}

function makePlan(): MiseWeeklyPlanDraft {
	const tueDinner = makeMeal({
		id: "meal:tue_dinner",
		date: "2026-05-12",
		slot: "dinner",
		// Title deliberately clean — the critic also scans the title and we
		// want the swap_ingredient to actually resolve the grievance.
		title: "Pan-Seared Protein Bowl",
		format: "bowl",
		ingredient_names: ["salmon", "rice"],
		raw_ingredients: [
			{ name: "salmon", qty: 200, unit: "g", grams: 200 },
			{ name: "rice", qty: 150, unit: "g", grams: 150 },
		],
	});
	const wedDinner = makeMeal({
		id: "meal:wed_dinner",
		date: "2026-05-13",
		slot: "dinner",
		title: "Tofu Stir-fry",
		format: "skillet",
		ingredient_names: ["tofu", "broccoli"],
	});
	return {
		id: "mise_plan:u10",
		household_id: "test",
		title: "U10 fixture",
		start_date: "2026-05-12",
		end_date: "2026-05-13",
		timezone: "UTC",
		people: 2,
		status: "draft",
		constraints: { dietary: ["vegetarian"] },
		selected_ingredients: [],
		source_recipe_ids: [],
		meals_by_day: [
			{ date: "2026-05-12", day_index: 0, meals: [tueDinner] },
			{ date: "2026-05-13", day_index: 1, meals: [wedDinner] },
		],
		component_batches: [],
		prep_tasks: [],
		breakfasts: [],
		snack_boxes: [],
		shopping_list: [],
		shop_runs: [],
		storage_labels: [],
		meta: { generated_by: "mise_graph_planner", deterministic: true },
	};
}

function makeMeal(partial: Partial<MisePlanMeal> & {
	id: string; date: string; slot: MisePlanMeal["slot"]; title: string;
}): MisePlanMeal {
	return {
		id: partial.id,
		date: partial.date,
		slot: partial.slot,
		title: partial.title,
		format: partial.format ?? "bowl",
		component_ids: partial.component_ids ?? [],
		ingredient_names: partial.ingredient_names ?? [],
		source: partial.source ?? "synthetic_test",
		notes: partial.notes ?? [],
		people: partial.people ?? 2,
		cuisine: partial.cuisine ?? [],
		locked: partial.locked ?? false,
		raw_ingredients: partial.raw_ingredients,
		leftovers_to: partial.leftovers_to,
	};
}

export default u10;
