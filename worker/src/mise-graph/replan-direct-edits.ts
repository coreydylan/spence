// Direct-edit handlers for ReplanEvent kinds that don't translate cleanly
// to a single ripple-preview Mutation. Examples: cancel_cook, move_cook,
// change_anchors, change_people, mark_cooked, report_inventory, lock_slot,
// add_meal, skip_shop. These edits are deterministic structural mutations to
// the plan-state JSON, returned as a fresh deep-clone with a "dirty" flag.
//
// Lives separately from replan-events.ts so that file stays under our 400-line
// budget; the public surface there imports `applyDirectEdit` and the result
// type below.

import type { MiseWeeklyPlanDraft, MisePlanMeal, MiseMealSlot } from "./planner";
import { lockMeal } from "./locks";
import type { ReplanEvent } from "./replan-events";

export interface DirectEditResult {
	plan: MiseWeeklyPlanDraft;
	warnings: string[];
	dirty: boolean;
}

export function applyDirectEdit(plan: MiseWeeklyPlanDraft, event: ReplanEvent): DirectEditResult {
	switch (event.kind) {
		case "skip_shop":
			return editSkipShop(plan, event);
		case "lock_slot":
			return editLockSlot(plan, event);
		case "cancel_cook":
			return editCancelCook(plan, event);
		case "move_cook":
			return editMoveCook(plan, event);
		case "change_anchors":
			return editChangeAnchors(plan, event);
		case "change_people":
			return editChangePeople(plan, event);
		case "mark_cooked":
			return editMarkCooked(plan, event);
		case "report_inventory":
			return editReportInventory(plan, event);
		case "add_meal":
			return editAddMeal(plan, event);
		// Translated to mutations elsewhere — direct edits add nothing.
		case "skip_meal":
		case "move_meal":
		case "move_shop":
			return { plan, warnings: [], dirty: false };
	}
}

// ---------------------------------------------------------------------------
// Per-kind handlers
// ---------------------------------------------------------------------------

function editSkipShop(
	plan: MiseWeeklyPlanDraft,
	event: Extract<ReplanEvent, { kind: "skip_shop" }>,
): DirectEditResult {
	const runs = plan.shop_runs || [];
	const run = runs.find(r => r.id === event.run_id);
	if (!run) {
		return { plan, warnings: [`shop run not found: ${event.run_id}`], dirty: false };
	}
	const next = deepClone(plan);
	next.shop_runs = (next.shop_runs || []).filter(r => r.id !== event.run_id);
	const skipped = Array.isArray(next.meta.skipped_shop_runs)
		? (next.meta.skipped_shop_runs as unknown[]).slice()
		: [];
	skipped.push({ run_id: event.run_id, reason: event.reason || null, at: new Date().toISOString() });
	next.meta = { ...next.meta, skipped_shop_runs: skipped };
	return { plan: next, warnings: [], dirty: true };
}

function editLockSlot(
	plan: MiseWeeklyPlanDraft,
	event: Extract<ReplanEvent, { kind: "lock_slot" }>,
): DirectEditResult {
	const target = findMealAt(plan, event.slot.date, event.slot.slot);
	if (!target) {
		return { plan, warnings: [`no meal found at ${event.slot.date} ${event.slot.slot}`], dirty: false };
	}
	const next = lockMeal(plan, event.slot, { reason: event.reason, by: "user", scope: "hard" });
	return { plan: next, warnings: [], dirty: true };
}

function editCancelCook(
	plan: MiseWeeklyPlanDraft,
	event: Extract<ReplanEvent, { kind: "cancel_cook" }>,
): DirectEditResult {
	const tasks = plan.prep_tasks || [];
	const task = tasks.find(t => t.id === event.cook_id);
	if (!task) {
		return { plan, warnings: [`cook session not found: ${event.cook_id}`], dirty: false };
	}
	const next = deepClone(plan);
	next.prep_tasks = (next.prep_tasks || []).filter(t => t.id !== event.cook_id);
	return { plan: next, warnings: [], dirty: true };
}

function editMoveCook(
	plan: MiseWeeklyPlanDraft,
	event: Extract<ReplanEvent, { kind: "move_cook" }>,
): DirectEditResult {
	const tasks = plan.prep_tasks || [];
	const task = tasks.find(t => t.id === event.cook_id);
	if (!task) {
		return { plan, warnings: [`cook session not found: ${event.cook_id}`], dirty: false };
	}
	if (task.scheduled_date === event.new_date) {
		return { plan, warnings: [`cook session already on ${event.new_date}`], dirty: false };
	}
	const next = deepClone(plan);
	const matching = (next.prep_tasks || []).find(t => t.id === event.cook_id);
	if (matching) matching.scheduled_date = event.new_date;
	return { plan: next, warnings: [], dirty: true };
}

function editChangeAnchors(
	plan: MiseWeeklyPlanDraft,
	event: Extract<ReplanEvent, { kind: "change_anchors" }>,
): DirectEditResult {
	const next = deepClone(plan);
	const current = new Set((next.selected_ingredients || []).map(s => s.toLowerCase()));
	for (const a of event.add || []) current.add(a.toLowerCase());
	for (const r of event.remove || []) current.delete(r.toLowerCase());
	next.selected_ingredients = Array.from(current);
	const dirty = (event.add?.length || 0) > 0 || (event.remove?.length || 0) > 0;
	return { plan: next, warnings: dirty ? [] : ["change_anchors had no add/remove entries"], dirty };
}

function editChangePeople(
	plan: MiseWeeklyPlanDraft,
	event: Extract<ReplanEvent, { kind: "change_people" }>,
): DirectEditResult {
	if (!Number.isFinite(event.new_count) || event.new_count <= 0) {
		return { plan, warnings: ["change_people requires positive new_count"], dirty: false };
	}
	const next = deepClone(plan);
	const targetDates = new Set(event.for_dates || []);
	let touched = 0;
	const apply = (m: MisePlanMeal) => {
		if (targetDates.size === 0 || targetDates.has(m.date)) {
			if (m.people !== event.new_count) {
				m.people = event.new_count;
				touched++;
			}
		}
	};
	for (const day of next.meals_by_day || []) for (const m of day.meals) apply(m);
	for (const b of next.breakfasts || []) apply(b);
	for (const s of next.snack_boxes || []) {
		if (targetDates.size === 0 || targetDates.has(s.date)) {
			if (s.people !== event.new_count) {
				s.people = event.new_count;
				touched++;
			}
		}
	}
	if (targetDates.size === 0) {
		next.people = event.new_count;
		touched++;
	}
	return { plan: next, warnings: [], dirty: touched > 0 };
}

function editMarkCooked(
	plan: MiseWeeklyPlanDraft,
	event: Extract<ReplanEvent, { kind: "mark_cooked" }>,
): DirectEditResult {
	const target = findMealAt(plan, event.slot.date, event.slot.slot);
	if (!target) {
		return { plan, warnings: [`no meal found at ${event.slot.date} ${event.slot.slot}`], dirty: false };
	}
	const next = deepClone(plan);
	const meal = findMealAt(next, event.slot.date, event.slot.slot);
	if (!meal) return { plan, warnings: [`meal vanished from cloned plan`], dirty: false };
	const meta = (meal.meta || {}) as Record<string, unknown>;
	meta.cooked = true;
	meta.cooked_at = new Date().toISOString();
	if (event.was_substituted) {
		meta.cooked_substituted = true;
		if (event.substitution_notes) meta.cooked_substitution_notes = event.substitution_notes;
	}
	meal.meta = meta;
	return { plan: next, warnings: [], dirty: true };
}

function editReportInventory(
	plan: MiseWeeklyPlanDraft,
	event: Extract<ReplanEvent, { kind: "report_inventory" }>,
): DirectEditResult {
	if (!Array.isArray(event.items) || event.items.length === 0) {
		return { plan, warnings: ["report_inventory had no items"], dirty: false };
	}
	const next = deepClone(plan);
	const observation_at = event.observation_at || new Date().toISOString();
	const reports = Array.isArray(next.meta.inventory_reports)
		? (next.meta.inventory_reports as unknown[]).slice()
		: [];
	reports.push({ at: observation_at, items: event.items.slice() });
	next.meta = { ...next.meta, inventory_reports: reports };
	return { plan: next, warnings: [], dirty: true };
}

function editAddMeal(
	plan: MiseWeeklyPlanDraft,
	event: Extract<ReplanEvent, { kind: "add_meal" }>,
): DirectEditResult {
	const existing = findMealAt(plan, event.slot.date, event.slot.slot);
	if (existing) {
		return {
			plan,
			warnings: [`slot ${event.slot.date} ${event.slot.slot} already has a meal — use replace_meal or move_meal`],
			dirty: false,
		};
	}
	const next = deepClone(plan);
	const slotL = (event.slot.slot || "").toLowerCase().trim();
	if (!isMealSlot(slotL)) {
		return { plan, warnings: [`invalid slot kind: ${event.slot.slot}`], dirty: false };
	}
	const proposal = event.meal_proposal || {};
	const id = `meal:replan_${event.slot.date}_${slotL}_${shortHash(JSON.stringify(proposal))}`;
	const meal: MisePlanMeal = {
		id,
		date: event.slot.date,
		slot: slotL,
		title: proposal.title || `TBD ${slotL}`,
		format: proposal.format || "bowl",
		component_ids: [],
		ingredient_names: (proposal.raw_ingredients || []).map(r => r.name),
		source: "replan_event",
		notes: [],
		people: plan.people || 2,
		cuisine: proposal.cuisine ? proposal.cuisine.slice() : [],
		locked: false,
		raw_ingredients: (proposal.raw_ingredients || []).map(r => ({
			name: r.name,
			qty: r.qty ?? null,
			unit: r.unit ?? null,
			grams: null,
			category: null,
		})),
		method_summary: proposal.method_summary ?? null,
		meta: { added_by_replan: true, added_at: new Date().toISOString() },
	};
	let day = (next.meals_by_day || []).find(d => d.date === event.slot.date);
	if (!day) {
		day = { date: event.slot.date, day_index: pickDayIndex(next, event.slot.date), meals: [] };
		next.meals_by_day = [...(next.meals_by_day || []), day].sort((a, b) => a.date.localeCompare(b.date));
	}
	day.meals.push(meal);
	return { plan: next, warnings: [], dirty: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function isMealSlot(s: string): s is MiseMealSlot {
	return s === "breakfast" || s === "lunch" || s === "dinner" || s === "snack";
}

function pickDayIndex(plan: MiseWeeklyPlanDraft, date: string): number {
	const start = plan.start_date;
	if (!start) return 0;
	const sa = Date.parse(`${start}T00:00:00Z`);
	const sb = Date.parse(`${date}T00:00:00Z`);
	if (!Number.isFinite(sa) || !Number.isFinite(sb)) return 0;
	return Math.max(0, Math.round((sb - sa) / 86_400_000));
}

function deepClone<T>(value: T): T {
	if (typeof structuredClone === "function") return structuredClone(value);
	return JSON.parse(JSON.stringify(value)) as T;
}

function shortHash(input: string): string {
	let h = 0;
	for (let i = 0; i < input.length; i++) {
		h = (h * 31 + input.charCodeAt(i)) | 0;
	}
	return Math.abs(h).toString(36).slice(0, 6);
}
