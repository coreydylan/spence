// Real-time replan events — the bridge between life ("we're going out
// Wednesday", "kid sick, cancel today", "pantry already has tofu") and the
// mise-graph world model.
//
// Each ReplanEvent is a high-level intent. We translate it into one or more
// world-model Mutations (the same shape RipplePreview consumes), or, for
// events that don't have a clean single mutation, we apply a direct edit to
// the active plan (see replan-direct-edits.ts). Either way we re-run the
// critics, diff the grievance set, and return a structured summary the caller
// can show the user / agent.
//
// Pure intent → preview → optional commit. Non-destructive when `dry_run`.
//
// This module deliberately does NOT touch the in-memory proposal cache that
// RipplePreview manages — it owns its own preview-and-commit lifecycle so
// the webhook can be stateless across requests.

import type { MiseGraphEnv } from "./types";
import type { MiseWeeklyPlanDraft, MisePlanMeal } from "./planner";
import { loadActivePlan, saveActivePlan } from "./active-plans";
import {
	previewCancelMeal,
	previewMoveMeal,
	previewMoveShop,
	commit as commitProposal,
	type Mutation,
	type RipplePreview,
} from "./ripple-preview";
import { runHardCritics, runWarningCritics, type Grievance } from "./critics";
import { isMealLocked } from "./locks";
import { applyDirectEdit } from "./replan-direct-edits";
import { composeHumanSummary, makeSyntheticNoOp, makeFailureResult } from "./replan-summary";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ReplanEvent =
	| { kind: "skip_meal"; slot: { date: string; slot: string }; reason?: string }
	| {
		kind: "add_meal";
		slot: { date: string; slot: string };
		meal_proposal?: {
			title?: string;
			format?: string;
			cuisine?: string[];
			raw_ingredients?: Array<{ name: string; qty?: number; unit?: string }>;
			method_summary?: string;
		};
	}
	| { kind: "move_meal"; from: { date: string; slot: string }; to: { date: string; slot: string }; mode?: "replace" | "swap" }
	| { kind: "cancel_cook"; cook_id: string; reason?: string }
	| { kind: "move_cook"; cook_id: string; new_date: string }
	| { kind: "skip_shop"; run_id: string; reason?: string }
	| { kind: "move_shop"; run_id: string; new_date: string }
	| { kind: "change_anchors"; add?: string[]; remove?: string[] }
	| { kind: "change_people"; new_count: number; for_dates?: string[] }
	| { kind: "lock_slot"; slot: { date: string; slot: string }; reason: string }
	| {
		kind: "mark_cooked";
		slot: { date: string; slot: string };
		was_substituted?: boolean;
		substitution_notes?: string;
	}
	| {
		kind: "report_inventory";
		items: Array<{ canonical_name: string; qty: number; unit: string }>;
		observation_at?: string;
	};

export interface ReplanResult {
	plan_id: string;
	event: ReplanEvent;
	applied: boolean;
	ripple_summary: {
		affected_meals: number;
		affected_cooks: number;
		affected_shop_items: number;
		new_grievances: number;
		resolved_grievances: number;
	};
	details: {
		new_grievance_messages: string[];
		resolved_grievance_messages: string[];
		cascade_proposals?: Array<{ kind: string; description: string }>;
	};
	warnings: string[];
	human_summary: string;
}

// ---------------------------------------------------------------------------
// Event → Mutation translation
// ---------------------------------------------------------------------------

/**
 * Translate a high-level life event into zero or more world-model mutations.
 *
 * Events that don't have a clean single Mutation (cancel_cook, change_people,
 * change_anchors, mark_cooked, report_inventory, lock_slot, add_meal,
 * skip_shop) return an empty array — applyReplanEvent handles them via direct
 * plan edits in replan-direct-edits.ts.
 */
export function eventToMutations(event: ReplanEvent): Mutation[] {
	switch (event.kind) {
		case "skip_meal":
			return [{ kind: "cancel_meal", slot: event.slot }];
		case "move_meal":
			return [{ kind: "move_meal", from: event.from, to: event.to, mode: event.mode || "replace" }];
		case "move_shop":
			return [{ kind: "move_shop", run_id: event.run_id, new_date: event.new_date }];
		case "skip_shop":
		case "add_meal":
		case "cancel_cook":
		case "move_cook":
		case "change_anchors":
		case "change_people":
		case "lock_slot":
		case "mark_cooked":
		case "report_inventory":
			return [];
	}
}

// ---------------------------------------------------------------------------
// applyReplanEvent — load plan, dispatch event, re-audit, return diff
// ---------------------------------------------------------------------------

export async function applyReplanEvent(
	env: MiseGraphEnv,
	plan_id: string,
	event: ReplanEvent,
	opts?: { dry_run?: boolean },
): Promise<ReplanResult> {
	const dry = !!opts?.dry_run;

	const plan = await loadActivePlan(env, plan_id);
	if (!plan) {
		return makeFailureResult(plan_id, event, [`active plan not found: ${plan_id}`]);
	}

	const lockWarning = checkSlotLock(plan, event);
	const preGrievances = safeRun(() => runHardCritics(plan));
	const preWarnings = safeRun(() => runWarningCritics(plan));

	const previews: RipplePreview[] = [];
	let workingPlan: MiseWeeklyPlanDraft = plan;
	const mutations = eventToMutations(event);
	for (const mutation of mutations) {
		const preview = dispatchMutation(workingPlan, mutation);
		previews.push(preview);
		if (preview.preview_state) {
			workingPlan = preview.preview_state.plan;
		}
	}

	const direct = applyDirectEdit(workingPlan, event);
	workingPlan = direct.plan;

	const postGrievances = safeRun(() => runHardCritics(workingPlan));
	const postWarnings = safeRun(() => runWarningCritics(workingPlan));
	const { newGrievances, resolvedGrievances } = diffGrievanceLists(
		[...preGrievances, ...preWarnings],
		[...postGrievances, ...postWarnings],
	);

	const affected = aggregateRippleSummary(
		previews, plan, workingPlan, newGrievances.length, resolvedGrievances.length,
	);
	const allWarnings = [
		...(lockWarning ? [lockWarning] : []),
		...direct.warnings,
		...previews.flatMap(p => p.warnings),
	];

	const anyPreviewLanded = previews.some(p => !!p.preview_state);
	const wouldApply = anyPreviewLanded || direct.dirty;

	let applied = false;
	if (wouldApply && !dry) {
		let next = plan;
		for (const preview of previews) {
			if (preview.preview_state) {
				next = commitProposal(next, preview.proposal_id);
			}
		}
		const finalEdit = applyDirectEdit(next, event);
		next = finalEdit.plan;
		await saveActivePlan(env, next);
		applied = true;
	}

	const cascadeProposals = previews
		.flatMap(p => p.cascade_proposals)
		.map(c => ({ kind: c.kind, description: c.description }));

	const human_summary = composeHumanSummary(event, applied, affected, dry);

	return {
		plan_id,
		event,
		applied,
		ripple_summary: affected,
		details: {
			new_grievance_messages: newGrievances.map(g => `[${g.critic}] ${g.message}`).slice(0, 12),
			resolved_grievance_messages: resolvedGrievances.map(g => `[${g.critic}] ${g.message}`).slice(0, 12),
			cascade_proposals: cascadeProposals.length > 0 ? cascadeProposals : undefined,
		},
		warnings: allWarnings,
		human_summary,
	};
}

// ---------------------------------------------------------------------------
// Mutation dispatch
// ---------------------------------------------------------------------------

function dispatchMutation(plan: MiseWeeklyPlanDraft, mutation: Mutation): RipplePreview {
	switch (mutation.kind) {
		case "cancel_meal":
			return previewCancelMeal(plan, mutation.slot);
		case "move_meal":
			return previewMoveMeal(plan, mutation.from, mutation.to, mutation.mode || "replace");
		case "move_shop":
			return previewMoveShop(plan, mutation.run_id, mutation.new_date);
		default:
			return makeSyntheticNoOp(mutation, [`mutation kind not wired into replan: ${mutation.kind}`]);
	}
}

// ---------------------------------------------------------------------------
// Aggregation + summary
// ---------------------------------------------------------------------------

function aggregateRippleSummary(
	previews: RipplePreview[],
	pre: MiseWeeklyPlanDraft,
	post: MiseWeeklyPlanDraft,
	newGrievanceCount: number,
	resolvedGrievanceCount: number,
): ReplanResult["ripple_summary"] {
	let affected_meals = 0;
	let affected_cooks = 0;
	let affected_shop_items = 0;
	const seenMeals = new Set<string>();
	const seenTasks = new Set<string>();
	for (const p of previews) {
		for (const m of p.affected_meals) {
			if (!seenMeals.has(m.meal_id)) { seenMeals.add(m.meal_id); affected_meals++; }
		}
		for (const t of p.affected_prep_tasks) {
			if (!seenTasks.has(t.task_id)) { seenTasks.add(t.task_id); affected_cooks++; }
		}
		affected_shop_items += p.affected_shopping.added.length + p.affected_shopping.removed.length;
	}
	// Direct-edit deltas on cooks (cancel_cook, move_cook): structural diff.
	const preTaskIds = new Set((pre.prep_tasks || []).map(t => t.id));
	const postTaskIds = new Set((post.prep_tasks || []).map(t => t.id));
	for (const id of preTaskIds) {
		if (!postTaskIds.has(id) && !seenTasks.has(id)) { affected_cooks++; seenTasks.add(id); }
	}
	const preTaskByDate = new Map((pre.prep_tasks || []).map(t => [t.id, t.scheduled_date] as const));
	for (const t of post.prep_tasks || []) {
		const before = preTaskByDate.get(t.id);
		if (before !== undefined && before !== t.scheduled_date && !seenTasks.has(t.id)) {
			affected_cooks++; seenTasks.add(t.id);
		}
	}
	// Add-meal direct edits: count added meals not in pre.
	const preMealIds = new Set<string>();
	for (const day of pre.meals_by_day || []) for (const m of day.meals) preMealIds.add(m.id);
	for (const m of pre.breakfasts || []) preMealIds.add(m.id);
	for (const day of post.meals_by_day || []) {
		for (const m of day.meals) {
			if (!preMealIds.has(m.id) && !seenMeals.has(m.id)) {
				seenMeals.add(m.id); affected_meals++;
			}
		}
	}
	return {
		affected_meals,
		affected_cooks,
		affected_shop_items,
		new_grievances: newGrievanceCount,
		resolved_grievances: resolvedGrievanceCount,
	};
}

function diffGrievanceLists(
	pre: Grievance[],
	post: Grievance[],
): { newGrievances: Grievance[]; resolvedGrievances: Grievance[] } {
	const key = (g: Grievance) => {
		const slot = g.slot_ref ? `${g.slot_ref.date}::${g.slot_ref.slot}` : "";
		const batch = g.batch_id || "";
		return `${g.critic}|${slot}|${batch}|${(g.message || "").slice(0, 80)}`;
	};
	const preMap = new Map<string, Grievance>();
	const postMap = new Map<string, Grievance>();
	for (const g of pre) preMap.set(key(g), g);
	for (const g of post) postMap.set(key(g), g);
	const newGrievances: Grievance[] = [];
	const resolvedGrievances: Grievance[] = [];
	for (const [k, v] of postMap) if (!preMap.has(k)) newGrievances.push(v);
	for (const [k, v] of preMap) if (!postMap.has(k)) resolvedGrievances.push(v);
	return { newGrievances, resolvedGrievances };
}

function checkSlotLock(plan: MiseWeeklyPlanDraft, event: ReplanEvent): string | null {
	const slotEvent = event.kind === "skip_meal" || event.kind === "lock_slot" || event.kind === "mark_cooked"
		? event.slot
		: null;
	if (!slotEvent) return null;
	const target = findMealAt(plan, slotEvent.date, slotEvent.slot);
	if (!target) return null;
	if (event.kind === "skip_meal" && isMealLocked(target)) {
		return `slot ${slotEvent.date} ${slotEvent.slot} is locked, can't skip without unlocking first`;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

function safeRun<T>(fn: () => T[]): T[] {
	try {
		return fn() || [];
	} catch {
		return [];
	}
}

function findMealAt(plan: MiseWeeklyPlanDraft, date: string, slot: string): MisePlanMeal | undefined {
	const slotL = (slot || "").toLowerCase().trim();
	for (const day of plan.meals_by_day || []) {
		if (day.date !== date) continue;
		for (const m of day.meals) if (m.slot.toLowerCase() === slotL) return m;
	}
	if (slotL === "breakfast") {
		for (const m of plan.breakfasts || []) if (m.date === date) return m;
	}
	return undefined;
}

// Re-export so Wave 5F integrators only need one import.
export { previewCancelMeal, previewMoveMeal, previewMoveShop } from "./ripple-preview";
