// Optimistic-lock metadata for mise-graph entities (meals, batches, shop runs,
// prep tasks). Locks are a coordination layer the revision loop and other
// agents read before mutating: a locked entity is pinned by its owner and
// the repair / revision pipeline must skip it (or at most warn — never
// silently rewrite it).
//
// Storage: lock metadata lives in the entity's existing `meta` bag under the
// key `lock` (a `LockMeta` value). All helpers here are pure — they return
// fresh copies. This module deliberately does NOT touch the resource ledger.
//
// See u06_lock_helpers.ts and t08_locked_slot_resists_revision.ts for the
// contract.
import type {
	MisePlanComponentBatch,
	MisePlanMeal,
	MisePlanTask,
	MiseSnackBox,
	MiseWeeklyPlanDraft,
} from "./planner";

export type LockedEntityType = "Meal" | "Cook" | "Shop" | "Batch" | "Sequence";
export type LockBy = "user" | "agent" | "system";
export type LockScope = "soft" | "hard";

export interface LockMeta {
	locked: boolean;
	lock_reason?: string;       // human-readable
	lock_by?: LockBy;
	locked_at?: string;         // ISO timestamp
	lock_token?: string;        // opaque ID for optimistic concurrency
	lock_scope?: LockScope;     // soft = warn on mutation; hard = refuse mutation
}

export interface SlotKey {
	date: string;
	slot: string;
}

export interface LockOpts {
	reason: string;
	by?: LockBy;
	scope?: LockScope;
	token?: string;
	at?: string;
}

export interface LockedEntityRef {
	type: LockedEntityType;
	id: string;
	meta: LockMeta;
}

const STALE_LOCK_DAYS = 30;
const DAY_MS = 86400000;

type AnyMeta = Record<string, unknown> | undefined;
type MetaTransform = (current: AnyMeta) => Record<string, unknown>;

export function isLocked(meta: LockMeta | undefined | null): boolean {
	return !!meta && meta.locked === true;
}

export function lockEntity(current: LockMeta | undefined, opts: LockOpts): LockMeta {
	const now = opts.at || new Date().toISOString();
	return {
		...(current || {}),
		locked: true,
		lock_reason: opts.reason,
		lock_by: opts.by || "user",
		lock_scope: opts.scope || "hard",
		locked_at: now,
		lock_token: opts.token || generateToken(now, opts.reason),
	};
}

export function unlockEntity(current: LockMeta): LockMeta {
	const next: LockMeta = { ...current, locked: false };
	delete next.lock_reason;
	delete next.lock_by;
	delete next.lock_scope;
	delete next.locked_at;
	delete next.lock_token;
	return next;
}

export function getEntityLock(meta: AnyMeta | null): LockMeta | null {
	if (!meta) return null;
	const lock = (meta as { lock?: unknown }).lock;
	if (!lock || typeof lock !== "object") return null;
	const candidate = lock as LockMeta;
	return typeof candidate.locked === "boolean" ? candidate : null;
}

export function isStaleLock(meta: LockMeta, now: string = new Date().toISOString()): boolean {
	if (!meta.locked || !meta.locked_at) return false;
	const lockedMs = Date.parse(meta.locked_at);
	const nowMs = Date.parse(now);
	if (!Number.isFinite(lockedMs) || !Number.isFinite(nowMs)) return false;
	return (nowMs - lockedMs) > STALE_LOCK_DAYS * DAY_MS;
}

export function listLockedEntities(plan: MiseWeeklyPlanDraft): LockedEntityRef[] {
	const out: LockedEntityRef[] = [];
	const collect = (type: LockedEntityType, id: string, meta: AnyMeta) => {
		const lock = getEntityLock(meta);
		if (isLocked(lock)) out.push({ type, id, meta: lock! });
	};

	for (const day of plan.meals_by_day || []) {
		for (const meal of day.meals) collect("Meal", meal.id, meal.meta);
	}
	for (const breakfast of plan.breakfasts || []) collect("Meal", breakfast.id, breakfast.meta);
	for (const snack of plan.snack_boxes || []) collect("Meal", snack.id, snack.meta);
	for (const batch of plan.component_batches || []) collect("Batch", batch.id, batch.meta);
	for (const task of plan.prep_tasks || []) collect("Cook", task.id, task.meta);
	for (const run of plan.shop_runs || []) collect("Shop", run.id, run.meta);

	return out;
}

export function findLockById(plan: MiseWeeklyPlanDraft, id: string): LockMeta | null {
	const ref = listLockedEntities(plan).find(r => r.id === id);
	return ref ? ref.meta : null;
}

export function isMealLocked(meal: MisePlanMeal | MiseSnackBox | undefined | null): boolean {
	return !!meal && isLocked(getEntityLock(meal.meta));
}

export function isBatchLocked(batch: MisePlanComponentBatch | undefined | null): boolean {
	return !!batch && isLocked(getEntityLock(batch.meta));
}

export function isTaskLocked(task: MisePlanTask | undefined | null): boolean {
	return !!task && isLocked(getEntityLock(task.meta));
}

// Plan-level mutators (pure — return new plan).

export function lockMeal(plan: MiseWeeklyPlanDraft, slot: SlotKey, opts: LockOpts): MiseWeeklyPlanDraft {
	return updateMealMeta(plan, slot, applyLock(opts));
}

export function unlockMeal(plan: MiseWeeklyPlanDraft, slot: SlotKey): MiseWeeklyPlanDraft {
	return updateMealMeta(plan, slot, applyUnlock);
}

export function lockBatch(plan: MiseWeeklyPlanDraft, batch_id: string, opts: LockOpts): MiseWeeklyPlanDraft {
	return updateBatchMeta(plan, batch_id, applyLock(opts));
}

export function unlockBatch(plan: MiseWeeklyPlanDraft, batch_id: string): MiseWeeklyPlanDraft {
	return updateBatchMeta(plan, batch_id, applyUnlock);
}

export function lockTask(plan: MiseWeeklyPlanDraft, task_id: string, opts: LockOpts): MiseWeeklyPlanDraft {
	return updateTaskMeta(plan, task_id, applyLock(opts));
}

export function unlockTask(plan: MiseWeeklyPlanDraft, task_id: string): MiseWeeklyPlanDraft {
	return updateTaskMeta(plan, task_id, applyUnlock);
}

// Internals.

function applyLock(opts: LockOpts): MetaTransform {
	return (current) => withLock(current, lockEntity(getEntityLock(current) || undefined, opts));
}

function applyUnlock(current: AnyMeta): Record<string, unknown> {
	const existing = getEntityLock(current);
	if (!existing) return current || {};
	return withLock(current, unlockEntity(existing));
}

function withLock(meta: AnyMeta, lock: LockMeta): Record<string, unknown> {
	return { ...(meta || {}), lock };
}

function updateMealMeta(plan: MiseWeeklyPlanDraft, slot: SlotKey, transform: MetaTransform): MiseWeeklyPlanDraft {
	const cloned = clonePlan(plan);
	const matchSlot = slot.slot.toLowerCase();
	let touched = false;

	for (const day of cloned.meals_by_day || []) {
		if (day.date !== slot.date) continue;
		for (const meal of day.meals) {
			if (meal.slot.toLowerCase() !== matchSlot) continue;
			meal.meta = transform(meal.meta);
			touched = true;
		}
	}
	if (matchSlot === "breakfast") {
		for (const meal of cloned.breakfasts || []) {
			if (meal.date !== slot.date) continue;
			meal.meta = transform(meal.meta);
			touched = true;
		}
	}
	if (matchSlot === "snack") {
		for (const snack of cloned.snack_boxes || []) {
			if (snack.date !== slot.date) continue;
			snack.meta = transform(snack.meta);
			touched = true;
		}
	}
	return touched ? cloned : plan;
}

function updateBatchMeta(plan: MiseWeeklyPlanDraft, batchId: string, transform: MetaTransform): MiseWeeklyPlanDraft {
	const cloned = clonePlan(plan);
	let touched = false;
	for (const batch of cloned.component_batches || []) {
		if (batch.id !== batchId) continue;
		batch.meta = transform(batch.meta);
		touched = true;
	}
	return touched ? cloned : plan;
}

function updateTaskMeta(plan: MiseWeeklyPlanDraft, taskId: string, transform: MetaTransform): MiseWeeklyPlanDraft {
	const cloned = clonePlan(plan);
	let touched = false;
	for (const task of cloned.prep_tasks || []) {
		if (task.id !== taskId) continue;
		task.meta = transform(task.meta);
		touched = true;
	}
	return touched ? cloned : plan;
}

function clonePlan(plan: MiseWeeklyPlanDraft): MiseWeeklyPlanDraft {
	return JSON.parse(JSON.stringify(plan)) as MiseWeeklyPlanDraft;
}

function generateToken(seedTime: string, reason: string): string {
	const timePart = seedTime.replace(/[^0-9]/g, "").slice(0, 14);
	const reasonPart = reason.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 16);
	return `lock_${timePart}_${reasonPart || "anon"}`;
}
