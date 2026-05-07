// RipplePreview — universal preview/commit protocol for the mise-graph planner.
//
// Every mutation to a plan flows through this module. We compute a structured
// `RipplePreview` that records exactly what changed: meals, batches, prep
// tasks, shopping list, dependency edges, grievances, score deltas, and
// (eventually) cascade proposals from individual critics. The same surface
// drives the LLM revision loop, agent critics' fixes, and the user's
// drag-drop UI.
//
// Design principles:
//   - Pure functions. No I/O, no LLM, no DB.
//   - Immutable inputs: we deep-clone the plan before mutating, then diff the
//     post-state against the original.
//   - In-memory proposal cache backs `commit()` so that previewed mutations
//     can be applied without re-deriving them.
//   - This module deliberately does NOT generate cascade proposals. That work
//     lives in critics.ts (Agent H). We just surface them onto the preview
//     when they appear on the new grievances.

import type {
	MiseWeeklyPlanDraft,
	MisePlanMeal,
	MisePlanComponentBatch,
	MisePlanTask,
	MiseShoppingListItem,
	MiseShoppingListSection,
	MisePlanDay,
	MiseSnackBox,
	MiseMealSlot,
} from "./planner";
import type { ShoppingRun } from "./shopping-list";
import { buildShoppingListV2 } from "./shopping-list";
import type { Grievance } from "./critics";
import { runHardCritics } from "./critics";
import { deriveDependencyEdges, type DependencyEdge } from "./dependency-edges";
import { isMealLocked, isBatchLocked, getEntityLock, isLocked } from "./locks";
import type { ComposerRawIngredient } from "./menu-composer";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReplaceMealNewMeal {
	title?: string;
	format?: string;
	cuisine?: string[];
	raw_ingredients?: Array<{ name: string; qty?: number; unit?: string; grams?: number }>;
	method_summary?: string;
	formula_ids?: string[];
	leftovers_to?: string[];
}

export type Mutation =
	| { kind: "cancel_meal"; slot: { date: string; slot: string } }
	| { kind: "move_meal"; from: { date: string; slot: string }; to: { date: string; slot: string }; mode?: "replace" | "swap" }
	| { kind: "swap_ingredient"; slot: { date: string; slot: string }; from_name: string; to_name: string; field?: "raw_ingredients" | "leftovers_to" }
	// Split a batch around a date — uses on/before at_date - 1d stay on the original;
	// uses on/after at_date move to a new "_b2" sub-batch.
	| { kind: "split_batch"; batch_id: string; at_date: string }
	// Replace the meal at slot with `new_meal` content (keeps the same id) or, if
	// only `must_consume` hints are provided, a deterministic placeholder.
	| { kind: "replace_meal"; slot: { date: string; slot: string }; new_meal?: ReplaceMealNewMeal; must_consume?: string[]; must_avoid?: string[] }
	// Reschedule a shopping run to a new date.
	| { kind: "move_shop"; run_id: string; new_date: string }
	// Slide a batch's prep date (and its associated prep_task scheduled_date).
	| { kind: "slide_prep_date"; batch_id: string; new_prep_date: string };

export interface MealDelta {
	meal_id: string;
	date: string;
	slot: string;
	change: "removed" | "added" | "modified" | "moved" | "side_effect";
	before?: Partial<MisePlanMeal>;
	after?: Partial<MisePlanMeal>;
	detail?: string;
}

export interface BatchDelta {
	batch_id: string;
	change: "added" | "removed" | "planned_uses_changed" | "qty_changed" | "orphaned" | "split" | "merged";
	before?: { planned_uses_count: number; quality_window_hours: number | null; quantity?: number };
	after?: { planned_uses_count: number; quality_window_hours: number | null; quantity?: number };
	detail?: string;
}

export interface PrepTaskDelta {
	task_id: string;
	change: "added" | "removed" | "moved" | "modified";
	before?: { scheduled_date: string; active_time_min: number };
	after?: { scheduled_date: string; active_time_min: number };
	detail?: string;
}

export interface ShoppingDelta {
	added: MiseShoppingListItem[];
	removed: MiseShoppingListItem[];
	qty_changed: Array<{ name: string; before: number | null; after: number | null; unit: string | null }>;
	runs_changed: Array<{ run_id: string; change: "added" | "removed" | "moved" | "resized"; detail?: string }>;
}

export interface RipplePreviewScores {
	waste_delta: number;     // grams of projected waste reduced (positive = better)
	variety_delta: number;   // diversity score change (positive = better)
	effort_delta: number;    // active prep min change (negative = better)
	reuse_delta: number;     // cross-meal component reuse score change
	net_delta: number;       // composite for ranking proposals
}

export interface CascadeProposal {
	kind: string;
	description: string;
	mutation?: Mutation;
}

export interface RipplePreview {
	proposed_change: Mutation;
	affected_meals: MealDelta[];
	affected_batches: BatchDelta[];
	affected_prep_tasks: PrepTaskDelta[];
	affected_shopping: ShoppingDelta;
	affected_edges: { added: DependencyEdge[]; removed: DependencyEdge[]; status_changed: DependencyEdge[] };
	new_grievances: Grievance[];
	resolved_grievances: Grievance[];
	scores: RipplePreviewScores;
	cascade_proposals: CascadeProposal[];
	reversible: boolean;
	warnings: string[];
	proposal_id: string;
	preview_state?: { plan: MiseWeeklyPlanDraft };
}

// ---------------------------------------------------------------------------
// Proposal cache (in-memory, no TTL — caller-managed lifetime)
// ---------------------------------------------------------------------------

const PROPOSAL_CACHE = new Map<string, RipplePreview>();

export function clearProposalCache(): void {
	PROPOSAL_CACHE.clear();
}

// ---------------------------------------------------------------------------
// Public entrypoints
// ---------------------------------------------------------------------------

export function previewCancelMeal(plan: MiseWeeklyPlanDraft, slot: { date: string; slot: string }): RipplePreview {
	const mutation: Mutation = { kind: "cancel_meal", slot };

	// Lock check.
	const target = findMealAt(plan, slot.date, slot.slot);
	if (target && isMealLocked(target)) {
		return makeBlockedPreview(mutation, plan, "target slot is hard-locked");
	}

	if (!target) {
		return makeNoOpPreview(mutation, plan, [`no meal found at ${slot.date} ${slot.slot}`]);
	}

	const post = deepClone(plan);
	removeMealFromPlan(post, slot.date, slot.slot);
	cleanupBatchesAfterMealRemoval(post, target);
	stripBackwardLeftoverClaimsTo(post, slot.date, slot.slot);

	return finalize(mutation, plan, post);
}

export function previewMoveMeal(
	plan: MiseWeeklyPlanDraft,
	from: { date: string; slot: string },
	to: { date: string; slot: string },
	mode: "replace" | "swap" = "replace",
): RipplePreview {
	const mutation: Mutation = { kind: "move_meal", from, to, mode };

	const fromMeal = findMealAt(plan, from.date, from.slot);
	if (!fromMeal) {
		return makeNoOpPreview(mutation, plan, [`no meal at source slot ${from.date} ${from.slot}`]);
	}
	if (isMealLocked(fromMeal)) {
		return makeBlockedPreview(mutation, plan, "source slot is hard-locked");
	}
	const toMeal = findMealAt(plan, to.date, to.slot);
	if (toMeal && isMealLocked(toMeal)) {
		return makeBlockedPreview(mutation, plan, "destination slot is hard-locked");
	}

	const post = deepClone(plan);
	const movingMeal = findMealAt(post, from.date, from.slot)!;
	const destMeal = findMealAt(post, to.date, to.slot);

	// Snapshot moving meal then remove it from source.
	const movingSnapshot: MisePlanMeal = deepClone(movingMeal);
	removeMealFromPlan(post, from.date, from.slot);

	// If destination has a meal:
	//   - replace: drop it, optionally clean up its batches.
	//   - swap:    move it to the source slot.
	if (destMeal) {
		removeMealFromPlan(post, to.date, to.slot);
		if (mode === "swap") {
			const swapped: MisePlanMeal = {
				...deepClone(destMeal),
				date: from.date,
				slot: normalizeSlot(from.slot) as MiseMealSlot,
			};
			insertMealIntoPlan(post, swapped);
		} else {
			cleanupBatchesAfterMealRemoval(post, destMeal);
		}
	}

	// Place the moving meal at the destination (always replace at that slot).
	const placed: MisePlanMeal = {
		...movingSnapshot,
		date: to.date,
		slot: normalizeSlot(to.slot) as MiseMealSlot,
	};
	insertMealIntoPlan(post, placed);

	// Update batch planned_uses to follow the moving meal.
	updateBatchUsesForMove(post, movingSnapshot.id, from.date, from.slot, to.date, to.slot);

	return finalize(mutation, plan, post);
}

export function previewSwapIngredient(
	plan: MiseWeeklyPlanDraft,
	slot: { date: string; slot: string },
	fromName: string,
	toName: string,
): RipplePreview {
	const mutation: Mutation = { kind: "swap_ingredient", slot, from_name: fromName, to_name: toName };

	const target = findMealAt(plan, slot.date, slot.slot);
	if (!target) {
		return makeNoOpPreview(mutation, plan, [`no meal found at ${slot.date} ${slot.slot}`]);
	}
	if (isMealLocked(target)) {
		return makeBlockedPreview(mutation, plan, "target slot is hard-locked");
	}

	const post = deepClone(plan);
	const meal = findMealAt(post, slot.date, slot.slot)!;
	swapIngredientInMeal(meal, fromName, toName);

	return finalize(mutation, plan, post);
}

// ---------------------------------------------------------------------------
// previewSplitBatch — shard a batch's planned_uses around at_date so its uses
// always fit within the quality_window. Uses on/before at_date - 1d stay on
// the original batch; uses on/after at_date move to a new "_b2" sub-batch.
// Affected meals' component_ids are rewritten to point at the right sub-batch.
// ---------------------------------------------------------------------------

export function previewSplitBatch(
	plan: MiseWeeklyPlanDraft,
	batch_id: string,
	at_date: string,
): RipplePreview {
	const mutation: Mutation = { kind: "split_batch", batch_id, at_date };

	const original = (plan.component_batches || []).find(b => b.id === batch_id);
	if (!original) {
		return makeNoOpPreview(mutation, plan, [`batch not found: ${batch_id}`]);
	}
	if (isBatchLocked(original)) {
		return makeBlockedPreview(mutation, plan, "batch locked");
	}

	const post = deepClone(plan);
	const originalPost = (post.component_batches || []).find(b => b.id === batch_id);
	if (!originalPost) {
		return makeNoOpPreview(mutation, plan, [`batch not found in cloned plan: ${batch_id}`]);
	}

	// Partition planned_uses around at_date.
	const allUses = (originalPost.planned_uses || []).slice();
	const stay = allUses.filter(u => u.date < at_date);
	const split = allUses.filter(u => u.date >= at_date);

	if (split.length === 0) {
		// Nothing crosses the at_date boundary — split is a no-op.
		return makeNoOpPreview(mutation, plan, [
			`split_batch at ${at_date} would not move any planned uses (all uses are on/before ${at_date})`,
		]);
	}

	// Build the new sub-batch.
	const newId = `${batch_id}_b2`;
	const newQuantity = (originalPost.quantity != null && Number.isFinite(originalPost.quantity))
		? Math.round((originalPost.quantity as number) / 2)
		: null;
	// Honor formula's idle_time_min when setting the new sub-batch's prep date.
	// A 48h-cold-ferment dough split for a Sat use shouldn't be prepped Sat —
	// it should be Sat - 2 days. Otherwise the new sub-batch immediately
	// triggers its own min_lead_time edge violation post-split (which we just
	// observed driving the score negative in production).
	const idleHours = originalPost.idle_time_min || 0;
	const idleDays = Math.ceil(idleHours / 60 / 24);
	const subPrepDate = idleDays > 0 ? subtractDaysISO(at_date, idleDays) : at_date;
	const newBatch: typeof originalPost = {
		...deepClone(originalPost),
		id: newId,
		planned_uses: split,
		quantity: newQuantity,
		meta: {
			...originalPost.meta,
			split_from: batch_id,
			split_index: 1,
			split_total: 2,
			desired_prep_date: subPrepDate,
		},
	};

	// Reduce the original's planned_uses + quantity.
	originalPost.planned_uses = stay;
	if (originalPost.quantity != null && Number.isFinite(originalPost.quantity)) {
		originalPost.quantity = Math.round((originalPost.quantity as number) / 2);
	}

	// Add the new sub-batch to the plan.
	post.component_batches = [...(post.component_batches || []), newBatch];

	// Rewrite each meal's component_ids: any meal pointing at batch_id whose
	// date is on/after at_date now points at newId.
	const allMealsPost = collectAllMeals(post);
	for (const meal of allMealsPost) {
		if (!meal.component_ids || meal.component_ids.length === 0) continue;
		meal.component_ids = meal.component_ids.map(cid => {
			if (cid !== batch_id) return cid;
			return meal.date >= at_date ? newId : cid;
		});
	}
	for (const snack of post.snack_boxes || []) {
		if (!snack.component_ids || snack.component_ids.length === 0) continue;
		snack.component_ids = snack.component_ids.map(cid => {
			if (cid !== batch_id) return cid;
			return snack.date >= at_date ? newId : cid;
		});
	}

	// Synthesize a prep_task for the new sub-batch (so the diff reflects the
	// extra prep effort). We mirror the planner's prep_task shape — the actual
	// task scheduling happens at commit time on the calling side, but the
	// preview surfaces the effort.
	const synthesizedTask = {
		id: `${newId}_prep`,
		scheduled_date: subPrepDate,
		session_order: 0,
		task_type: "component_prep",
		title: `Prep ${originalPost.label} (refresh)`,
		station_tags: originalPost.station_tags || [],
		equipment: originalPost.equipment || [],
		depends_on: [],
		state_inputs: [],
		state_outputs: [newId],
		active_time_min: originalPost.active_time_min || 0,
		idle_time_min: originalPost.idle_time_min || 0,
		instructions: [`Refresh batch (split from ${batch_id} on ${at_date})`],
		status: "planned" as const,
		meta: { synthesized_by: "previewSplitBatch", split_from: batch_id },
	};
	post.prep_tasks = [...(post.prep_tasks || []), synthesizedTask];

	return finalize(mutation, plan, post);
}

// ---------------------------------------------------------------------------
// previewReplaceMeal — replace the meal at slot with new content. The meal
// id is preserved so cross-references (component_ids, leftovers_to claims
// pointing at this slot) keep working. If only `must_consume` is supplied,
// build a deterministic placeholder meal whose raw_ingredients reflect the
// hints — degraded mode the loop can still commit when no LLM is wired in.
// ---------------------------------------------------------------------------

export function previewReplaceMeal(
	plan: MiseWeeklyPlanDraft,
	slot: { date: string; slot: string },
	new_meal?: ReplaceMealNewMeal,
	hints?: { must_consume?: string[]; must_avoid?: string[] },
): RipplePreview {
	const mutation: Mutation = {
		kind: "replace_meal",
		slot,
		new_meal,
		must_consume: hints?.must_consume,
		must_avoid: hints?.must_avoid,
	};

	const target = findMealAt(plan, slot.date, slot.slot);
	if (!target) {
		return makeNoOpPreview(mutation, plan, [`no meal found at ${slot.date} ${slot.slot}`]);
	}
	if (isMealLocked(target)) {
		return makeBlockedPreview(mutation, plan, "target slot is hard-locked");
	}

	const hasNewMeal = !!new_meal && (
		!!new_meal.title
		|| !!new_meal.format
		|| (new_meal.raw_ingredients && new_meal.raw_ingredients.length > 0)
		|| (new_meal.cuisine && new_meal.cuisine.length > 0)
		|| !!new_meal.method_summary
	);
	const mustConsume = hints?.must_consume || [];
	const hasHints = mustConsume.length > 0;

	const mustAvoid = hints?.must_avoid || [];
	const hasMustAvoid = mustAvoid.length > 0;

	if (!hasNewMeal && !hasHints && !hasMustAvoid) {
		return makeNoOpPreview(mutation, plan, [
			"replace_meal requires new_meal, must_consume, or must_avoid hints",
		]);
	}

	const post = deepClone(plan);
	const meal = findMealAt(post, slot.date, slot.slot)!;

	if (hasNewMeal && new_meal) {
		// Apply the explicit new_meal content while preserving the meal id.
		if (new_meal.title) meal.title = new_meal.title;
		if (new_meal.format) meal.format = new_meal.format;
		if (new_meal.cuisine) meal.cuisine = new_meal.cuisine.slice();
		if (new_meal.method_summary !== undefined) meal.method_summary = new_meal.method_summary;
		if (new_meal.leftovers_to) meal.leftovers_to = new_meal.leftovers_to.slice();
		if (new_meal.raw_ingredients) {
			meal.raw_ingredients = new_meal.raw_ingredients.map(r => ({
				name: r.name,
				qty: r.qty ?? null,
				unit: r.unit ?? null,
				grams: r.grams ?? null,
				category: null,
			}));
			meal.ingredient_names = new_meal.raw_ingredients.map(r => r.name);
		}
		if (new_meal.formula_ids) {
			const meta = (meal.meta || {}) as Record<string, unknown>;
			meal.meta = { ...meta, formula_ids: new_meal.formula_ids.slice() };
		}
	} else if (hasHints) {
		// Degraded placeholder — a meal that consumes the hint ingredients.
		const list = mustConsume.slice();
		meal.title = `TBD — must consume: ${list.join(", ")}`;
		meal.raw_ingredients = list.map(name => ({
			name,
			qty: null,
			unit: null,
			grams: null,
			category: null,
		}));
		meal.ingredient_names = list.slice();
		const note = "agent-suggested replacement";
		meal.notes = [...(meal.notes || []), note];
	} else if (hasMustAvoid) {
		// must_avoid only (typical ShelfLifeCritic shape — "replace this meal
		// with one that doesn't use X"). Without an LLM-suggested replacement
		// we can't compose a positive alternative, but we CAN strip the
		// avoid-list inputs from the existing meal and mark it for revisit.
		// This still resolves the originating shelf-life grievance because
		// the offending batch reference is removed from this meal's
		// component_ids and raw_ingredients.
		const avoidPat = new RegExp(`\\b(${mustAvoid.map(escapeRe).join("|")})\\b`, "i");
		meal.raw_ingredients = (meal.raw_ingredients || []).filter(r => !avoidPat.test(r.name || ""));
		meal.ingredient_names = (meal.ingredient_names || []).filter(n => !avoidPat.test(n));
		meal.title = `${meal.title} (must avoid: ${mustAvoid.join(", ")})`;
		const note = `agent-stripped: avoiding ${mustAvoid.join(", ")} — needs revisit`;
		meal.notes = [...(meal.notes || []), note];
	}

	// The replacement meal probably no longer claims the same component_ids —
	// drop them. Downstream batches' planned_uses for this meal will appear as
	// orphaned in the diff (which is correct: the new meal isn't using them).
	meal.component_ids = [];

	// Strip any planned_uses on batches that pointed at this meal (they no
	// longer apply). Surface as planned_uses_changed in the batch diff.
	for (const batch of post.component_batches || []) {
		if (!batch.planned_uses) continue;
		batch.planned_uses = batch.planned_uses.filter(u => u.meal_id !== meal.id);
	}

	return finalize(mutation, plan, post);
}

// ---------------------------------------------------------------------------
// previewMoveShop — reschedule a shopping run to a new date. The run carries
// categories + item_count; the actual items live in shopping_list sections
// (matched by category). Re-running shopFreshness on the post-state surfaces
// new/resolved freshness violations.
// ---------------------------------------------------------------------------

export function previewMoveShop(
	plan: MiseWeeklyPlanDraft,
	run_id: string,
	new_date: string,
): RipplePreview {
	const mutation: Mutation = { kind: "move_shop", run_id, new_date };

	const run = (plan.shop_runs || []).find(r => r.id === run_id);
	if (!run) {
		return makeNoOpPreview(mutation, plan, [`shop run not found: ${run_id}`]);
	}
	if (run.date === new_date) {
		return makeNoOpPreview(mutation, plan, [`shop run already on ${new_date}`]);
	}

	const post = deepClone(plan);
	const runs = post.shop_runs || [];
	const idx = runs.findIndex(r => r.id === run_id);
	if (idx < 0) {
		return makeNoOpPreview(mutation, plan, [`shop run not found in cloned plan: ${run_id}`]);
	}
	runs[idx] = { ...runs[idx], date: new_date };
	post.shop_runs = runs;

	return finalize(mutation, plan, post, { skipShoppingRebuild: true });
}

// ---------------------------------------------------------------------------
// previewSlidePrepDate — shift a batch's desired_prep_date and its prep_task
// scheduled_date. Re-running deriveDependencyEdges on the post-state captures
// any newly violated / newly satisfied min_lead_time edges.
// ---------------------------------------------------------------------------

export function previewSlidePrepDate(
	plan: MiseWeeklyPlanDraft,
	batch_id: string,
	new_prep_date: string,
): RipplePreview {
	const mutation: Mutation = { kind: "slide_prep_date", batch_id, new_prep_date };

	const batch = (plan.component_batches || []).find(b => b.id === batch_id);
	if (!batch) {
		return makeNoOpPreview(mutation, plan, [`batch not found: ${batch_id}`]);
	}
	if (isBatchLocked(batch)) {
		return makeBlockedPreview(mutation, plan, "batch locked");
	}

	const post = deepClone(plan);
	const targetBatch = (post.component_batches || []).find(b => b.id === batch_id);
	if (!targetBatch) {
		return makeNoOpPreview(mutation, plan, [`batch not found in cloned plan: ${batch_id}`]);
	}

	// Update the batch's desired_prep_date annotation.
	targetBatch.meta = { ...(targetBatch.meta || {}), desired_prep_date: new_prep_date };

	// Find every prep_task whose state_outputs include this batch.
	const matching = (post.prep_tasks || []).filter(t =>
		Array.isArray(t.state_outputs) && t.state_outputs.includes(batch_id));
	for (const task of matching) {
		task.scheduled_date = new_prep_date;
	}

	return finalize(mutation, plan, post);
}

export function commit(plan: MiseWeeklyPlanDraft, proposal_id: string): MiseWeeklyPlanDraft {
	const preview = PROPOSAL_CACHE.get(proposal_id);
	if (!preview) {
		throw new Error(`commit: unknown proposal_id "${proposal_id}"`);
	}
	if (!preview.preview_state) {
		// No-op preview (lock/blocked/missing target). Return the input unchanged.
		return plan;
	}
	return deepClone(preview.preview_state.plan);
}

// ---------------------------------------------------------------------------
// finalize: compute deltas + register the preview
// ---------------------------------------------------------------------------

interface FinalizeOptions {
	skipShoppingRebuild?: boolean;   // for move_shop: don't re-derive shop_runs
}

function finalize(
	mutation: Mutation,
	pre: MiseWeeklyPlanDraft,
	post: MiseWeeklyPlanDraft,
	options: FinalizeOptions = {},
): RipplePreview {
	// Rebuild shopping list on the post-state so the diff is honest, except
	// when the caller explicitly preserved shop_runs (e.g. move_shop, where
	// we are mutating the run dates by hand and a rebuild would clobber them).
	let preForDiff: MiseWeeklyPlanDraft;
	if (options.skipShoppingRebuild) {
		preForDiff = deepClone(pre);
	} else {
		rebuildShoppingList(post);
		// pre may also have been built by the planner but not by us — rebuild to
		// keep the diff symmetric.
		preForDiff = rebuildShoppingListClone(pre);
	}

	const affected_meals = diffMeals(preForDiff, post, mutation);
	const affected_batches = diffBatches(preForDiff, post);
	const affected_prep_tasks = diffPrepTasks(preForDiff, post);
	const affected_shopping = diffShopping(preForDiff, post);
	const affected_edges = diffEdges(preForDiff, post);

	const preGrievances = safeRunHardCritics(preForDiff);
	const postGrievances = safeRunHardCritics(post);
	const { newGrievances, resolvedGrievances } = diffGrievances(preGrievances, postGrievances);

	const scores = computeScores(preForDiff, post);

	const cascade_proposals = collectCascadeProposals(newGrievances);

	const proposal_id = generateProposalId();

	const preview: RipplePreview = {
		proposed_change: mutation,
		affected_meals,
		affected_batches,
		affected_prep_tasks,
		affected_shopping,
		affected_edges,
		new_grievances: newGrievances,
		resolved_grievances: resolvedGrievances,
		scores,
		cascade_proposals,
		reversible: true,
		warnings: [],
		proposal_id,
		preview_state: { plan: post },
	};

	PROPOSAL_CACHE.set(proposal_id, preview);
	return preview;
}

// ---------------------------------------------------------------------------
// No-op / blocked previews
// ---------------------------------------------------------------------------

function makeNoOpPreview(mutation: Mutation, _plan: MiseWeeklyPlanDraft, warnings: string[]): RipplePreview {
	const proposal_id = generateProposalId();
	const preview: RipplePreview = {
		proposed_change: mutation,
		affected_meals: [],
		affected_batches: [],
		affected_prep_tasks: [],
		affected_shopping: { added: [], removed: [], qty_changed: [], runs_changed: [] },
		affected_edges: { added: [], removed: [], status_changed: [] },
		new_grievances: [],
		resolved_grievances: [],
		scores: { waste_delta: 0, variety_delta: 0, effort_delta: 0, reuse_delta: 0, net_delta: 0 },
		cascade_proposals: [],
		reversible: true,
		warnings,
		proposal_id,
	};
	PROPOSAL_CACHE.set(proposal_id, preview);
	return preview;
}

function makeBlockedPreview(mutation: Mutation, _plan: MiseWeeklyPlanDraft, reason: string): RipplePreview {
	return makeNoOpPreview(mutation, _plan, [reason]);
}

// ---------------------------------------------------------------------------
// Mutation helpers — operating on a cloned plan
// ---------------------------------------------------------------------------

function findMealAt(plan: MiseWeeklyPlanDraft, date: string, slot: string): MisePlanMeal | undefined {
	const slotL = normalizeSlot(slot);
	for (const day of plan.meals_by_day || []) {
		if (day.date !== date) continue;
		for (const meal of day.meals) {
			if (meal.slot.toLowerCase() === slotL) return meal;
		}
	}
	if (slotL === "breakfast") {
		for (const meal of plan.breakfasts || []) {
			if (meal.date === date) return meal;
		}
	}
	return undefined;
}

function removeMealFromPlan(plan: MiseWeeklyPlanDraft, date: string, slot: string): void {
	const slotL = normalizeSlot(slot);
	for (const day of plan.meals_by_day || []) {
		if (day.date !== date) continue;
		day.meals = day.meals.filter(m => m.slot.toLowerCase() !== slotL);
	}
	if (slotL === "breakfast") {
		plan.breakfasts = (plan.breakfasts || []).filter(m => m.date !== date);
	}
}

function insertMealIntoPlan(plan: MiseWeeklyPlanDraft, meal: MisePlanMeal): void {
	const slotL = normalizeSlot(meal.slot);
	if (slotL === "breakfast") {
		// Use the legacy `meals_by_day` shape — keeps the diff machinery simple.
	}
	let day = (plan.meals_by_day || []).find(d => d.date === meal.date);
	if (!day) {
		day = {
			date: meal.date,
			day_index: pickDayIndex(plan, meal.date),
			meals: [],
		} as MisePlanDay;
		plan.meals_by_day = [...(plan.meals_by_day || []), day].sort((a, b) => a.date.localeCompare(b.date));
	}
	// Replace any existing meal at that slot, then append.
	day.meals = day.meals.filter(m => m.slot.toLowerCase() !== slotL);
	day.meals.push(meal);
}

function pickDayIndex(plan: MiseWeeklyPlanDraft, date: string): number {
	const start = plan.start_date;
	if (!start) return 0;
	const sa = Date.parse(`${start}T00:00:00Z`);
	const sb = Date.parse(`${date}T00:00:00Z`);
	if (!Number.isFinite(sa) || !Number.isFinite(sb)) return 0;
	return Math.max(0, Math.round((sb - sa) / 86_400_000));
}

function cleanupBatchesAfterMealRemoval(plan: MiseWeeklyPlanDraft, removedMeal: MisePlanMeal): void {
	const survivingMealIds = collectMealIds(plan);
	for (const batch of plan.component_batches || []) {
		batch.planned_uses = (batch.planned_uses || []).filter(u => survivingMealIds.has(u.meal_id));
	}
	// Don't actually remove the batch — surface it in the diff as `orphaned`.
}

function stripBackwardLeftoverClaimsTo(plan: MiseWeeklyPlanDraft, date: string, slot: string): void {
	const slotL = normalizeSlot(slot);
	const target = `${date} ${slotL}`;
	const allMeals = collectAllMeals(plan);
	for (const meal of allMeals) {
		if (!meal.leftovers_to) continue;
		meal.leftovers_to = meal.leftovers_to.filter(c => c.toLowerCase().trim() !== target);
	}
}

function updateBatchUsesForMove(
	plan: MiseWeeklyPlanDraft,
	mealId: string,
	fromDate: string,
	fromSlot: string,
	toDate: string,
	toSlot: string,
): void {
	const fromSlotL = normalizeSlot(fromSlot) as MiseMealSlot;
	const toSlotL = normalizeSlot(toSlot) as MiseMealSlot;
	for (const batch of plan.component_batches || []) {
		batch.planned_uses = (batch.planned_uses || []).map(u => {
			if (u.meal_id === mealId && u.date === fromDate && normalizeSlot(u.slot) === fromSlotL) {
				return { ...u, date: toDate, slot: toSlotL };
			}
			return u;
		});
	}
}

function swapIngredientInMeal(meal: MisePlanMeal, fromName: string, toName: string): void {
	const fromL = fromName.toLowerCase().trim();
	if (Array.isArray(meal.raw_ingredients)) {
		meal.raw_ingredients = meal.raw_ingredients.map(r =>
			r.name && r.name.toLowerCase().trim() === fromL ? { ...r, name: toName } : r,
		);
	}
	if (Array.isArray(meal.ingredient_names)) {
		meal.ingredient_names = meal.ingredient_names.map(n =>
			n.toLowerCase().trim() === fromL ? toName : n,
		);
	}
}

// ---------------------------------------------------------------------------
// Shopping list rebuild
// ---------------------------------------------------------------------------

function rebuildShoppingListClone(pre: MiseWeeklyPlanDraft): MiseWeeklyPlanDraft {
	const cloned = deepClone(pre);
	rebuildShoppingList(cloned);
	return cloned;
}

function rebuildShoppingList(plan: MiseWeeklyPlanDraft): void {
	const llmRaw: ComposerRawIngredient[] = [
		...(plan.meals_by_day || []).flatMap(d => d.meals.flatMap(m => m.raw_ingredients || [])),
		...(plan.breakfasts || []).flatMap(b => b.raw_ingredients || []),
		...(plan.snack_boxes || []).flatMap(s => s.raw_ingredients || []),
	];
	try {
		const result = buildShoppingListV2({
			startDate: plan.start_date,
			endDate: plan.end_date,
			pantry: new Set<string>(),
			componentBatches: plan.component_batches || [],
			formulaCatalog: [],
			mealsByDay: plan.meals_by_day || [],
			breakfasts: plan.breakfasts || [],
			snackBoxes: plan.snack_boxes || [],
			llmRawIngredients: llmRaw,
		});
		plan.shopping_list = result.sections;
		plan.shop_runs = result.runs;
	} catch {
		// On any failure, leave the plan's existing shopping list untouched. The
		// diff will then show "no change" rather than spuriously failing.
	}
}

// ---------------------------------------------------------------------------
// Diff helpers
// ---------------------------------------------------------------------------

function diffMeals(pre: MiseWeeklyPlanDraft, post: MiseWeeklyPlanDraft, mutation: Mutation): MealDelta[] {
	const preMeals = collectAllMealsWithKey(pre);
	const postMeals = collectAllMealsWithKey(post);
	const out: MealDelta[] = [];

	const preById = new Map<string, MisePlanMeal>();
	for (const { meal } of preMeals) preById.set(meal.id, meal);
	const postById = new Map<string, MisePlanMeal>();
	for (const { meal } of postMeals) postById.set(meal.id, meal);

	// Removed
	for (const { meal } of preMeals) {
		if (!postById.has(meal.id)) {
			out.push({
				meal_id: meal.id,
				date: meal.date,
				slot: meal.slot,
				change: "removed",
				before: shallowMealView(meal),
			});
		}
	}
	// Added
	for (const { meal } of postMeals) {
		if (!preById.has(meal.id)) {
			out.push({
				meal_id: meal.id,
				date: meal.date,
				slot: meal.slot,
				change: "added",
				after: shallowMealView(meal),
			});
		}
	}
	// Moved or modified (same id present in both)
	for (const { meal: pm } of postMeals) {
		const pre = preById.get(pm.id);
		if (!pre) continue;
		if (pre.date !== pm.date || pre.slot !== pm.slot) {
			out.push({
				meal_id: pm.id,
				date: pm.date,
				slot: pm.slot,
				change: "moved",
				before: shallowMealView(pre),
				after: shallowMealView(pm),
			});
		} else if (mealStateChanged(pre, pm)) {
			out.push({
				meal_id: pm.id,
				date: pm.date,
				slot: pm.slot,
				change: "modified",
				before: shallowMealView(pre),
				after: shallowMealView(pm),
				detail: describeMealDiff(pre, pm),
			});
		}
	}

	// Side effects: meals whose leftover-source disappeared.
	if (mutation.kind === "cancel_meal") {
		const removedMeal = preById.get(`${mutation.slot.date}::${normalizeSlot(mutation.slot.slot)}`)
			|| preMeals.find(p => p.meal.date === mutation.slot.date
				&& normalizeSlot(p.meal.slot) === normalizeSlot(mutation.slot.slot))?.meal;
		const removedClaims = removedMeal?.leftovers_to || [];
		for (const claim of removedClaims) {
			const m = claim.match(/^(\d{4}-\d{2}-\d{2})\s+(breakfast|lunch|dinner|snack)$/i);
			if (!m) continue;
			const downstream = postMeals.find(p => p.meal.date === m[1] && normalizeSlot(p.meal.slot) === m[2].toLowerCase());
			if (!downstream) continue;
			// Avoid double-listing if it was already a "modified" entry.
			if (out.some(d => d.meal_id === downstream.meal.id)) continue;
			out.push({
				meal_id: downstream.meal.id,
				date: downstream.meal.date,
				slot: downstream.meal.slot,
				change: "side_effect",
				detail: `lost leftover source from ${mutation.slot.date} ${mutation.slot.slot}`,
			});
		}
	}

	return out;
}

function diffBatches(pre: MiseWeeklyPlanDraft, post: MiseWeeklyPlanDraft): BatchDelta[] {
	const preBy = new Map<string, MisePlanComponentBatch>();
	for (const b of pre.component_batches || []) preBy.set(b.id, b);
	const postBy = new Map<string, MisePlanComponentBatch>();
	for (const b of post.component_batches || []) postBy.set(b.id, b);

	const out: BatchDelta[] = [];
	for (const b of pre.component_batches || []) {
		const after = postBy.get(b.id);
		if (!after) {
			out.push({
				batch_id: b.id,
				change: "removed",
				before: batchView(b),
			});
			continue;
		}
		const beforeUses = (b.planned_uses || []).length;
		const afterUses = (after.planned_uses || []).length;
		if (afterUses === 0 && beforeUses > 0) {
			out.push({
				batch_id: b.id,
				change: "orphaned",
				before: batchView(b),
				after: batchView(after),
				detail: `lost all ${beforeUses} planned use(s); batch now has no consumer`,
			});
			continue;
		}
		if (beforeUses !== afterUses) {
			out.push({
				batch_id: b.id,
				change: "planned_uses_changed",
				before: batchView(b),
				after: batchView(after),
				detail: `planned_uses ${beforeUses} → ${afterUses}`,
			});
			continue;
		}
		if ((b.quantity ?? null) !== (after.quantity ?? null)) {
			out.push({
				batch_id: b.id,
				change: "qty_changed",
				before: batchView(b),
				after: batchView(after),
				detail: `quantity ${b.quantity ?? "null"} → ${after.quantity ?? "null"}`,
			});
		}
	}
	for (const b of post.component_batches || []) {
		if (!preBy.has(b.id)) {
			out.push({
				batch_id: b.id,
				change: "added",
				after: batchView(b),
			});
		}
	}
	return out;
}

function diffPrepTasks(pre: MiseWeeklyPlanDraft, post: MiseWeeklyPlanDraft): PrepTaskDelta[] {
	const preBy = new Map<string, MisePlanTask>();
	for (const t of pre.prep_tasks || []) preBy.set(t.id, t);
	const postBy = new Map<string, MisePlanTask>();
	for (const t of post.prep_tasks || []) postBy.set(t.id, t);

	const out: PrepTaskDelta[] = [];
	for (const t of pre.prep_tasks || []) {
		const after = postBy.get(t.id);
		if (!after) {
			out.push({ task_id: t.id, change: "removed", before: taskView(t) });
			continue;
		}
		if (t.scheduled_date !== after.scheduled_date) {
			out.push({
				task_id: t.id,
				change: "moved",
				before: taskView(t),
				after: taskView(after),
				detail: `${t.scheduled_date} → ${after.scheduled_date}`,
			});
			continue;
		}
		if (t.active_time_min !== after.active_time_min || t.title !== after.title) {
			out.push({
				task_id: t.id,
				change: "modified",
				before: taskView(t),
				after: taskView(after),
			});
		}
	}
	for (const t of post.prep_tasks || []) {
		if (!preBy.has(t.id)) {
			out.push({ task_id: t.id, change: "added", after: taskView(t) });
		}
	}
	return out;
}

function diffShopping(pre: MiseWeeklyPlanDraft, post: MiseWeeklyPlanDraft): ShoppingDelta {
	const preItems = flattenShoppingItems(pre.shopping_list || []);
	const postItems = flattenShoppingItems(post.shopping_list || []);

	const preBy = new Map(preItems.map(i => [i.name.toLowerCase(), i]));
	const postBy = new Map(postItems.map(i => [i.name.toLowerCase(), i]));

	const added: MiseShoppingListItem[] = [];
	const removed: MiseShoppingListItem[] = [];
	const qty_changed: ShoppingDelta["qty_changed"] = [];
	for (const [k, v] of preBy) {
		if (!postBy.has(k)) removed.push(v);
	}
	for (const [k, v] of postBy) {
		const before = preBy.get(k);
		if (!before) {
			added.push(v);
		} else if ((before.quantity ?? null) !== (v.quantity ?? null)) {
			qty_changed.push({ name: v.name, before: before.quantity ?? null, after: v.quantity ?? null, unit: v.unit });
		}
	}

	const runs_changed = diffRuns(pre.shop_runs || [], post.shop_runs || []);
	return { added, removed, qty_changed, runs_changed };
}

function diffRuns(preRuns: ShoppingRun[], postRuns: ShoppingRun[]): ShoppingDelta["runs_changed"] {
	const out: ShoppingDelta["runs_changed"] = [];
	const preBy = new Map(preRuns.map(r => [r.id, r]));
	const postBy = new Map(postRuns.map(r => [r.id, r]));
	for (const r of preRuns) {
		const after = postBy.get(r.id);
		if (!after) {
			out.push({ run_id: r.id, change: "removed", detail: `${r.label}` });
			continue;
		}
		if (r.date !== after.date) {
			out.push({ run_id: r.id, change: "moved", detail: `${r.date} → ${after.date}` });
		} else if (r.item_count !== after.item_count) {
			out.push({ run_id: r.id, change: "resized", detail: `items ${r.item_count} → ${after.item_count}` });
		}
	}
	for (const r of postRuns) {
		if (!preBy.has(r.id)) {
			out.push({ run_id: r.id, change: "added", detail: `${r.label}` });
		}
	}
	return out;
}

function diffEdges(pre: MiseWeeklyPlanDraft, post: MiseWeeklyPlanDraft): { added: DependencyEdge[]; removed: DependencyEdge[]; status_changed: DependencyEdge[] } {
	const preEdges = safeDeriveEdges(pre);
	const postEdges = safeDeriveEdges(post);
	const preBy = new Map(preEdges.map(e => [e.id, e]));
	const postBy = new Map(postEdges.map(e => [e.id, e]));

	const added: DependencyEdge[] = [];
	const removed: DependencyEdge[] = [];
	const status_changed: DependencyEdge[] = [];

	for (const e of preEdges) {
		if (!postBy.has(e.id)) removed.push(e);
	}
	for (const e of postEdges) {
		const before = preBy.get(e.id);
		if (!before) {
			added.push(e);
		} else if (before.status !== e.status) {
			status_changed.push(e);
		}
	}
	return { added, removed, status_changed };
}

function diffGrievances(pre: Grievance[], post: Grievance[]): { newGrievances: Grievance[]; resolvedGrievances: Grievance[] } {
	const preKeys = new Map(pre.map(g => [grievanceKey(g), g]));
	const postKeys = new Map(post.map(g => [grievanceKey(g), g]));
	const newGrievances: Grievance[] = [];
	const resolvedGrievances: Grievance[] = [];
	for (const [k, g] of postKeys) {
		if (!preKeys.has(k)) newGrievances.push(g);
	}
	for (const [k, g] of preKeys) {
		if (!postKeys.has(k)) resolvedGrievances.push(g);
	}
	return { newGrievances, resolvedGrievances };
}

function grievanceKey(g: Grievance): string {
	const slot = g.slot_ref ? `${g.slot_ref.date}::${g.slot_ref.slot}` : "";
	const batch = g.batch_id || "";
	const prefix = (g.message || "").slice(0, 80);
	return `${g.critic}|${slot}|${batch}|${prefix}`;
}

function collectCascadeProposals(grievances: Grievance[]): CascadeProposal[] {
	const out: CascadeProposal[] = [];
	for (const g of grievances) {
		const carrier = g as Grievance & { cascade_proposals?: unknown };
		if (!Array.isArray(carrier.cascade_proposals)) continue;
		for (const raw of carrier.cascade_proposals) {
			if (!raw || typeof raw !== "object") continue;
			const r = raw as { kind?: unknown; description?: unknown; mutation?: unknown };
			if (typeof r.kind !== "string" || typeof r.description !== "string") continue;
			out.push({
				kind: r.kind,
				description: r.description,
				mutation: (r.mutation && typeof r.mutation === "object") ? r.mutation as Mutation : undefined,
			});
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Score deltas
// ---------------------------------------------------------------------------

function computeScores(pre: MiseWeeklyPlanDraft, post: MiseWeeklyPlanDraft): RipplePreviewScores {
	const wastePre = projectedWasteGrams(pre);
	const wastePost = projectedWasteGrams(post);
	const waste_delta = wastePre - wastePost;

	const variety_delta = varietyScore(post) - varietyScore(pre);

	const effortPre = totalActiveMinutes(pre);
	const effortPost = totalActiveMinutes(post);
	const effort_delta = effortPost - effortPre;

	const reuse_delta = reuseScore(post) - reuseScore(pre);

	const net_delta = waste_delta + 2 * variety_delta + reuse_delta - 0.5 * effort_delta;

	return { waste_delta, variety_delta, effort_delta, reuse_delta, net_delta };
}

function projectedWasteGrams(plan: MiseWeeklyPlanDraft): number {
	// We deliberately approximate without going through ledgerFromPlan to keep
	// the diff cheap and side-effect free: count component batches whose
	// planned_uses count is zero (orphaned) — every gram of an orphaned batch
	// is projected waste. For non-orphaned batches we currently assume 0.
	let total = 0;
	for (const b of plan.component_batches || []) {
		const uses = (b.planned_uses || []).length;
		if (uses === 0) total += Number.isFinite(b.quantity ?? NaN) ? Number(b.quantity) : 0;
	}
	return total;
}

function varietyScore(plan: MiseWeeklyPlanDraft): number {
	const cuisines = new Set<string>();
	const formats = new Set<string>();
	for (const meal of collectAllMeals(plan)) {
		for (const c of meal.cuisine || []) cuisines.add(c.toLowerCase());
		if (meal.format) formats.add(meal.format.toLowerCase());
	}
	return cuisines.size + formats.size;
}

function totalActiveMinutes(plan: MiseWeeklyPlanDraft): number {
	let total = 0;
	for (const t of plan.prep_tasks || []) total += Number(t.active_time_min) || 0;
	for (const m of collectAllMeals(plan)) total += Number(m.active_time_min) || 0;
	return total;
}

function reuseScore(plan: MiseWeeklyPlanDraft): number {
	// Count meals that reference a batch via component_ids — the more meals
	// pointing at shared batches, the higher the reuse score.
	let count = 0;
	const batchIds = new Set((plan.component_batches || []).map(b => b.id));
	for (const meal of collectAllMeals(plan)) {
		for (const cid of meal.component_ids || []) {
			if (batchIds.has(cid)) {
				count++;
				break;
			}
		}
	}
	return count;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MealWithKey { meal: MisePlanMeal; key: string }

function collectAllMealsWithKey(plan: MiseWeeklyPlanDraft): MealWithKey[] {
	const out: MealWithKey[] = [];
	for (const day of plan.meals_by_day || []) {
		for (const m of day.meals) {
			out.push({ meal: m, key: `${m.date}::${normalizeSlot(m.slot)}` });
		}
	}
	for (const b of plan.breakfasts || []) {
		out.push({ meal: b, key: `${b.date}::breakfast` });
	}
	return out;
}

function collectAllMeals(plan: MiseWeeklyPlanDraft): MisePlanMeal[] {
	return collectAllMealsWithKey(plan).map(m => m.meal);
}

function collectMealIds(plan: MiseWeeklyPlanDraft): Set<string> {
	const ids = new Set<string>();
	for (const m of collectAllMeals(plan)) ids.add(m.id);
	for (const s of plan.snack_boxes || []) ids.add(s.id);
	return ids;
}

function shallowMealView(meal: MisePlanMeal): Partial<MisePlanMeal> {
	return {
		id: meal.id,
		date: meal.date,
		slot: meal.slot,
		title: meal.title,
		format: meal.format,
		component_ids: meal.component_ids,
		ingredient_names: meal.ingredient_names,
		people: meal.people,
		cuisine: meal.cuisine,
		locked: meal.locked,
	};
}

function batchView(b: MisePlanComponentBatch): { planned_uses_count: number; quality_window_hours: number | null; quantity?: number } {
	return {
		planned_uses_count: (b.planned_uses || []).length,
		quality_window_hours: b.quality_window_hours,
		quantity: b.quantity ?? undefined,
	};
}

function taskView(t: MisePlanTask): { scheduled_date: string; active_time_min: number } {
	return {
		scheduled_date: t.scheduled_date,
		active_time_min: t.active_time_min,
	};
}

function flattenShoppingItems(sections: MiseShoppingListSection[]): MiseShoppingListItem[] {
	const out: MiseShoppingListItem[] = [];
	for (const s of sections) for (const item of s.items) out.push(item);
	return out;
}

function mealStateChanged(a: MisePlanMeal, b: MisePlanMeal): boolean {
	if (a.title !== b.title) return true;
	if (a.format !== b.format) return true;
	if (a.people !== b.people) return true;
	if ((a.component_ids || []).join(",") !== (b.component_ids || []).join(",")) return true;
	if ((a.ingredient_names || []).join(",") !== (b.ingredient_names || []).join(",")) return true;
	const ar = (a.raw_ingredients || []).map(r => r.name).join(",");
	const br = (b.raw_ingredients || []).map(r => r.name).join(",");
	if (ar !== br) return true;
	const al = (a.leftovers_to || []).join(",");
	const bl = (b.leftovers_to || []).join(",");
	if (al !== bl) return true;
	return false;
}

function describeMealDiff(a: MisePlanMeal, b: MisePlanMeal): string {
	const parts: string[] = [];
	if (a.title !== b.title) parts.push(`title: "${a.title}" → "${b.title}"`);
	if (a.format !== b.format) parts.push(`format: ${a.format} → ${b.format}`);
	const ar = (a.raw_ingredients || []).map(r => r.name);
	const br = (b.raw_ingredients || []).map(r => r.name);
	if (ar.join(",") !== br.join(",")) parts.push(`ingredients changed`);
	return parts.join("; ");
}

function safeRunHardCritics(plan: MiseWeeklyPlanDraft): Grievance[] {
	try {
		return runHardCritics(plan);
	} catch {
		return [];
	}
}

function safeDeriveEdges(plan: MiseWeeklyPlanDraft): DependencyEdge[] {
	try {
		return deriveDependencyEdges(plan);
	} catch {
		return [];
	}
}

function normalizeSlot(slot: string): string {
	return (slot || "").toLowerCase().trim();
}

function subtractDaysISO(iso: string, days: number): string {
	const d = new Date(iso + "T00:00:00Z");
	d.setUTCDate(d.getUTCDate() - days);
	return d.toISOString().slice(0, 10);
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deepClone<T>(value: T): T {
	if (typeof structuredClone === "function") return structuredClone(value);
	return JSON.parse(JSON.stringify(value)) as T;
}

function generateProposalId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return `prop_${crypto.randomUUID()}`;
	}
	return `prop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// Re-export so callers can probe locks alongside ripple operations without
// importing two modules. Not strictly necessary; kept for ergonomics.
export { isMealLocked, getEntityLock, isLocked };
