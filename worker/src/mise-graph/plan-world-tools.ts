// PlanWorld tool core.
//
// This is the in-memory surface we can later expose through MCP protocol
// plumbing. It deliberately stays pure from the caller's perspective: reads
// derive compact views from { plan }, previews delegate to RipplePreview, and
// commits return a new world instead of mutating the input world.

import type {
	MiseMealSlot,
	MisePlanMeal,
	MiseSnackBox,
	MiseWeeklyPlanDraft,
} from "./planner";
import type { Grievance, GrievanceSeverity } from "./critics";
import { runHardCritics, runWarningCritics } from "./critics";
import {
	commit,
	previewCancelMeal,
	previewMoveMeal,
	previewMoveShop,
	previewReplaceMeal,
	previewSlidePrepDate,
	previewSplitBatch,
	previewSwapIngredient,
	type Mutation,
	type ReplaceMealNewMeal,
	type RipplePreview,
} from "./ripple-preview";
import { scorePlanCoherence, type CoherenceScoreResult } from "./coherence-score";
import { renderPlanMap, type RenderPlanMapOptions } from "./plan-map-renderer";

export interface PlanWorld {
	plan: MiseWeeklyPlanDraft;
}

export interface PlanWorldSlotRef {
	date: string;
	slot: MiseMealSlot;
}

export interface PlanWorldSummary {
	plan_id: string;
	title: string;
	start_date: string;
	end_date: string;
	day_count: number;
	meal_count: number;
	meals_by_slot: Record<MiseMealSlot, number>;
	component_batch_count: number;
	prep_task_count: number;
	shop_run_count: number;
	empty_slot_count: number;
	grievance_counts: GrievanceCounts;
	coherence_score: number;
	coherence_issue_count: number;
	coherence_hard_issue_count: number;
}

export interface GrievanceCounts {
	total: number;
	hard: number;
	warning: number;
	preference: number;
	by_critic: Record<string, number>;
}

export interface PlanWorldGrievanceRead {
	grievances: Grievance[];
	counts: GrievanceCounts;
}

export interface PlanWorldMealRead {
	slot: PlanWorldSlotRef;
	found: boolean;
	meal: PlanWorldMealView | null;
}

export interface PlanWorldMealView {
	id: string;
	date: string;
	slot: MiseMealSlot;
	title: string;
	format?: string;
	cuisine?: string[];
	people?: number;
	component_ids: string[];
	ingredient_names: string[];
	raw_ingredient_names: string[];
	raw_ingredients?: MisePlanMeal["raw_ingredients"];
	components?: MisePlanMeal["components"];
	leftovers_to?: string[];
	locked: boolean;
	kind: "meal" | "snack_box";
}

export interface PlanWorldCommitResult {
	proposal_id: string;
	world: PlanWorld;
	summary: PlanWorldSummary;
	grievances: PlanWorldGrievanceRead;
}

export interface PlanWorldFinalizeResult {
	ok: boolean;
	summary: PlanWorldSummary;
	grievances: PlanWorldGrievanceRead;
	coherence: CoherenceScoreResult;
}

export type PlanWorldMutationInput =
	| Mutation
	| ({ kind: string } & Record<string, unknown>);

const DEFAULT_SLOTS: MiseMealSlot[] = ["breakfast", "lunch", "dinner", "snack"];

export function createPlanWorld(initialPlan: MiseWeeklyPlanDraft): PlanWorld {
	return { plan: deepClone(initialPlan) };
}

export function planReadSummary(world: PlanWorld): PlanWorldSummary {
	return buildSummary(world, planReadGrievances(world));
}

export function planReadEmptySlots(
	world: PlanWorld,
	requestedSlots?: PlanWorldSlotRef[],
): PlanWorldSlotRef[] {
	const slots = requestedSlots && requestedSlots.length > 0
		? requestedSlots
		: enumeratePlanDates(world.plan).flatMap(date =>
			DEFAULT_SLOTS.map(slot => ({ date, slot })),
		);

	return slots.filter(slot => !isSlotOccupied(world.plan, slot.date, slot.slot));
}

export function planReadMeal(world: PlanWorld, slot: PlanWorldSlotRef): PlanWorldMealRead {
	const normalizedSlot = normalizeMealSlot(slot.slot);
	if (normalizedSlot === "snack") {
		const snack = findSnackAt(world.plan, slot.date);
		return {
			slot: { date: slot.date, slot: normalizedSlot },
			found: !!snack,
			meal: snack ? snackView(snack) : null,
		};
	}

	const meal = findMealAt(world.plan, slot.date, normalizedSlot);
	return {
		slot: { date: slot.date, slot: normalizedSlot },
		found: !!meal,
		meal: meal ? mealView(meal) : null,
	};
}

export function planReadGrievances(world: PlanWorld): PlanWorldGrievanceRead {
	const grievances = [
		...safeRunHardCritics(world.plan),
		...safeRunWarningCritics(world.plan),
	];
	return {
		grievances,
		counts: countGrievances(grievances),
	};
}

export function planReadCoherence(world: PlanWorld): CoherenceScoreResult {
	return scorePlanCoherence(world.plan);
}

export function planReadMap(world: PlanWorld, options: RenderPlanMapOptions = {}): string {
	return renderPlanMap(world.plan, options);
}

export function planPreviewMutation(
	world: PlanWorld,
	mutation: PlanWorldMutationInput,
): RipplePreview {
	const m = mutation as { kind: string } & Record<string, unknown>;

	switch (m.kind) {
		case "cancel_meal": {
			const slot = requireSlot(m.slot, "cancel_meal.slot");
			return previewCancelMeal(world.plan, slot);
		}
		case "move_meal": {
			const from = requireSlot(m.from ?? m.from_slot, "move_meal.from");
			const to = requireSlot(m.to ?? m.to_slot, "move_meal.to");
			const mode = m.mode === "swap" ? "swap" : "replace";
			return previewMoveMeal(world.plan, from, to, mode);
		}
		case "swap_ingredient": {
			const slot = requireSlot(m.slot, "swap_ingredient.slot");
			if (m.field && m.field !== "raw_ingredients") {
				throw new Error(`planPreviewMutation: swap_ingredient field "${String(m.field)}" is not supported by PlanWorld`);
			}
			return previewSwapIngredient(
				world.plan,
				slot,
				requireString(m.from_name, "swap_ingredient.from_name"),
				requireString(m.to_name, "swap_ingredient.to_name"),
			);
		}
		case "split_batch": {
			const atDate = requireString(m.at_date ?? m.split_at_date, "split_batch.at_date");
			return previewSplitBatch(
				world.plan,
				requireString(m.batch_id, "split_batch.batch_id"),
				atDate,
			);
		}
		case "replace_meal": {
			const slot = requireSlot(m.slot, "replace_meal.slot");
			const newMeal = coerceReplaceMealBody(m.new_meal);
			return previewReplaceMeal(world.plan, slot, newMeal, {
				must_consume: stringArray(m.must_consume),
				must_avoid: stringArray(m.must_avoid),
			});
		}
		case "move_shop": {
			return previewMoveShop(
				world.plan,
				requireString(m.run_id, "move_shop.run_id"),
				requireString(m.new_date, "move_shop.new_date"),
			);
		}
		case "slide_prep_date": {
			return previewSlidePrepDate(
				world.plan,
				requireString(m.batch_id, "slide_prep_date.batch_id"),
				requireString(m.new_prep_date, "slide_prep_date.new_prep_date"),
			);
		}
		default:
			throw new Error(`planPreviewMutation: unsupported mutation kind "${m.kind}"`);
	}
}

export function planCommitPreview(world: PlanWorld, proposal_id: string): PlanWorldCommitResult {
	const committedPlan = commit(world.plan, proposal_id);
	const nextWorld = createPlanWorld(committedPlan);
	const grievances = planReadGrievances(nextWorld);
	return {
		proposal_id,
		world: nextWorld,
		grievances,
		summary: buildSummary(nextWorld, grievances),
	};
}

export function planFinalize(world: PlanWorld): PlanWorldFinalizeResult {
	const grievances = planReadGrievances(world);
	const summary = buildSummary(world, grievances);
	const coherence = planReadCoherence(world);
	return {
		ok: grievances.counts.hard === 0 && coherence.score === 0,
		summary,
		grievances,
		coherence,
	};
}

function buildSummary(world: PlanWorld, grievanceRead: PlanWorldGrievanceRead): PlanWorldSummary {
	const plan = world.plan;
	const mealsBySlot = countMealsBySlot(plan);
	const mealCount = DEFAULT_SLOTS.reduce((sum, slot) => sum + mealsBySlot[slot], 0);
	const coherence = planReadCoherence(world);

	return {
		plan_id: plan.id,
		title: plan.title,
		start_date: plan.start_date,
		end_date: plan.end_date,
		day_count: enumeratePlanDates(plan).length,
		meal_count: mealCount,
		meals_by_slot: mealsBySlot,
		component_batch_count: (plan.component_batches || []).length,
		prep_task_count: (plan.prep_tasks || []).length,
		shop_run_count: (plan.shop_runs || []).length,
		empty_slot_count: planReadEmptySlots(world).length,
		grievance_counts: grievanceRead.counts,
		coherence_score: coherence.score,
		coherence_issue_count: coherence.issues.length,
		coherence_hard_issue_count: coherence.issues.filter(issue => issue.severity === "hard").length,
	};
}

function countMealsBySlot(plan: MiseWeeklyPlanDraft): Record<MiseMealSlot, number> {
	const counts: Record<MiseMealSlot, number> = {
		breakfast: 0,
		lunch: 0,
		dinner: 0,
		snack: 0,
	};
	for (const day of plan.meals_by_day || []) {
		for (const meal of day.meals || []) {
			counts[normalizeMealSlot(meal.slot)] += 1;
		}
	}
	for (const meal of plan.breakfasts || []) {
		counts[normalizeMealSlot(meal.slot)] += 1;
	}
	for (const _snack of plan.snack_boxes || []) {
		counts.snack += 1;
	}
	return counts;
}

function countGrievances(grievances: Grievance[]): GrievanceCounts {
	const counts: GrievanceCounts = {
		total: grievances.length,
		hard: 0,
		warning: 0,
		preference: 0,
		by_critic: {},
	};
	for (const grievance of grievances) {
		incrementSeverity(counts, grievance.severity);
		counts.by_critic[grievance.critic] = (counts.by_critic[grievance.critic] || 0) + 1;
	}
	return counts;
}

function incrementSeverity(counts: GrievanceCounts, severity: GrievanceSeverity): void {
	switch (severity) {
		case "hard":
			counts.hard += 1;
			break;
		case "warning":
			counts.warning += 1;
			break;
		case "preference":
			counts.preference += 1;
			break;
	}
}

function mealView(meal: MisePlanMeal): PlanWorldMealView {
	const view: PlanWorldMealView = {
		id: meal.id,
		date: meal.date,
		slot: normalizeMealSlot(meal.slot),
		title: meal.title,
		format: meal.format,
		component_ids: (meal.component_ids || []).slice(),
		ingredient_names: (meal.ingredient_names || []).slice(),
		raw_ingredient_names: (meal.raw_ingredients || []).map(r => r.name).filter(Boolean),
		locked: !!meal.locked,
		kind: "meal",
	};
	if (meal.cuisine) view.cuisine = meal.cuisine.slice();
	if (typeof meal.people === "number") view.people = meal.people;
	if (Array.isArray(meal.raw_ingredients)) view.raw_ingredients = meal.raw_ingredients.slice();
	if (Array.isArray(meal.components)) view.components = meal.components.slice();
	if (Array.isArray(meal.leftovers_to)) view.leftovers_to = meal.leftovers_to.slice();
	return view;
}

function snackView(snack: MiseSnackBox): PlanWorldMealView {
	return {
		id: snack.id,
		date: snack.date,
		slot: "snack",
		title: snack.title,
		format: "snack_box",
		component_ids: (snack.component_ids || []).slice(),
		ingredient_names: (snack.items || []).slice(),
		raw_ingredient_names: (snack.raw_ingredients || []).map(r => r.name).filter(Boolean),
		locked: !!snack.locked,
		kind: "snack_box",
	};
}

function isSlotOccupied(plan: MiseWeeklyPlanDraft, date: string, slot: string): boolean {
	const normalizedSlot = normalizeMealSlot(slot);
	if (normalizedSlot === "snack" && findSnackAt(plan, date)) return true;
	return !!findMealAt(plan, date, normalizedSlot);
}

function findMealAt(plan: MiseWeeklyPlanDraft, date: string, slot: string): MisePlanMeal | undefined {
	const normalizedSlot = normalizeMealSlot(slot);
	for (const day of plan.meals_by_day || []) {
		if (day.date !== date) continue;
		for (const meal of day.meals || []) {
			if (normalizeMealSlot(meal.slot) === normalizedSlot) return meal;
		}
	}
	if (normalizedSlot === "breakfast") {
		for (const meal of plan.breakfasts || []) {
			if (meal.date === date) return meal;
		}
	}
	return undefined;
}

function findSnackAt(plan: MiseWeeklyPlanDraft, date: string): MiseSnackBox | undefined {
	return (plan.snack_boxes || []).find(snack => snack.date === date);
}

function enumeratePlanDates(plan: MiseWeeklyPlanDraft): string[] {
	const fromBounds = enumerateDateRange(plan.start_date, plan.end_date);
	if (fromBounds.length > 0) return fromBounds;

	const dates = new Set<string>();
	for (const day of plan.meals_by_day || []) dates.add(day.date);
	for (const meal of plan.breakfasts || []) dates.add(meal.date);
	for (const snack of plan.snack_boxes || []) dates.add(snack.date);
	for (const use of (plan.component_batches || []).flatMap(batch => batch.planned_uses || [])) {
		dates.add(use.date);
	}
	return [...dates].sort();
}

function enumerateDateRange(start: string, end: string): string[] {
	if (!isIsoDate(start) || !isIsoDate(end)) return [];
	const startMs = Date.parse(`${start}T00:00:00Z`);
	const endMs = Date.parse(`${end}T00:00:00Z`);
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return [];

	const dates: string[] = [];
	const cursor = new Date(startMs);
	while (cursor.getTime() <= endMs && dates.length < 370) {
		dates.push(cursor.toISOString().slice(0, 10));
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}
	return dates;
}

function requireSlot(value: unknown, label: string): { date: string; slot: string } {
	if (!value || typeof value !== "object") {
		throw new Error(`planPreviewMutation: ${label} must be a slot object`);
	}
	const candidate = value as { date?: unknown; slot?: unknown };
	return {
		date: requireString(candidate.date, `${label}.date`),
		slot: requireString(candidate.slot, `${label}.slot`),
	};
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`planPreviewMutation: ${label} is required`);
	}
	return value;
}

function coerceReplaceMealBody(value: unknown): ReplaceMealNewMeal | undefined {
	if (!value || typeof value !== "object") return undefined;
	const source = value as Record<string, unknown>;
	const out: ReplaceMealNewMeal = {};

	if (typeof source.title === "string") out.title = source.title;
	if (typeof source.format === "string") out.format = source.format;
	if (typeof source.method_summary === "string") out.method_summary = source.method_summary;
	if (Array.isArray(source.cuisine)) out.cuisine = source.cuisine.filter(isString);
	if (Array.isArray(source.formula_ids)) out.formula_ids = source.formula_ids.filter(isString);
	if (Array.isArray(source.leftovers_to)) out.leftovers_to = source.leftovers_to.filter(isString);
	if (Array.isArray(source.raw_ingredients)) {
		out.raw_ingredients = source.raw_ingredients
			.filter(isRecord)
			.map(r => ({
				name: typeof r.name === "string" ? r.name : "",
				qty: typeof r.qty === "number" ? r.qty : undefined,
				unit: typeof r.unit === "string" ? r.unit : undefined,
				grams: typeof r.grams === "number" ? r.grams : undefined,
			}))
			.filter(r => r.name.length > 0);
	}

	return Object.keys(out).length > 0 ? out : undefined;
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const strings = value.filter(isString);
	return strings.length > 0 ? strings : undefined;
}

function safeRunHardCritics(plan: MiseWeeklyPlanDraft): Grievance[] {
	try {
		return runHardCritics(plan);
	} catch {
		return [];
	}
}

function safeRunWarningCritics(plan: MiseWeeklyPlanDraft): Grievance[] {
	try {
		return runWarningCritics(plan);
	} catch {
		return [];
	}
}

function normalizeMealSlot(slot: string): MiseMealSlot {
	const normalized = slot.toLowerCase().trim();
	if (DEFAULT_SLOTS.includes(normalized as MiseMealSlot)) {
		return normalized as MiseMealSlot;
	}
	throw new Error(`unsupported meal slot "${slot}"`);
}

function isIsoDate(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function deepClone<T>(value: T): T {
	if (typeof structuredClone === "function") return structuredClone(value);
	return JSON.parse(JSON.stringify(value)) as T;
}
