// Shelf-life-aware rebatch + prep-date scheduler.
//
// Two problems the previous planner had:
//
// (1) ALL batches got prepped on day 0 / day 1 regardless of when they were
//     used. So a 96h-shelf cold-fermented dough prepped Mon was being used
//     for pizza Sat (5+ days later) — past its quality window. And the same
//     batch was being claimed for ANOTHER pizza on day 12 — way past.
//
// (2) When a component's planned uses span more days than its shelf life,
//     the planner just used a single batch ID and pretended the dough kept
//     forever. A real chef would re-prep mid-window.
//
// This module fixes both:
//
// (a) `splitBatchesByShelfLife()` walks each batch's `planned_uses`, sorts
//     them by date, and whenever the gap between the first use of a sub-group
//     and the next use exceeds `shelf_life_hours_fridge`, it starts a new
//     sub-group. Each sub-group becomes its own batch (with a unique id and
//     its own slice of planned_uses).
//
// (b) `assignDesiredPrepDates()` sets each batch's preferred prep date to
//     `firstUseDate - 1 day` (or, if the formula has `make_ahead_best_min`,
//     uses that). The date is clamped to be on or after the plan start date.
//
// Both passes mutate / replace the batch list in place; downstream code
// reads `batch.meta.desired_prep_date` when scheduling prep tasks.

import type { MisePlanComponentBatch, MisePlanDay, MisePlanMeal, MiseSnackBox } from "./planner";
import type { MiseFormula } from "./ledger";

export interface RebatchReport {
	batches_split: number;
	batches_rescheduled: number;
	notes: string[];
}

const DAY_MS = 86400000;

/**
 * Rewrite every meal/breakfast/snack's `component_ids` so it points at the
 * sub-batch that actually covers its date. Without this, the original batch ID
 * remains in component_ids and the validator/repair pass thinks the original
 * is being used past its shelf life — generating a duplicate "Remake X" task.
 */
function reassignComponentIdsToSplits(
	originalToSplits: Map<string, MisePlanComponentBatch[]>,
	mealsByDay: MisePlanDay[],
	breakfasts: MisePlanMeal[],
	snackBoxes: MiseSnackBox[],
): void {
	const remap = (componentIds: string[], onDate: string): string[] => {
		return componentIds.map(id => {
			const splits = originalToSplits.get(id);
			if (!splits || splits.length <= 1) return id;
			// Find the split whose planned_uses[0].date <= onDate <= last use
			for (const split of splits) {
				const uses = split.planned_uses;
				if (!uses.length) continue;
				const first = uses[0].date;
				const last = uses[uses.length - 1].date;
				if (onDate >= first && onDate <= last) return split.id;
			}
			return splits[0].id;
		});
	};
	for (const day of mealsByDay) {
		for (const meal of day.meals) {
			if (meal.component_ids?.length) {
				meal.component_ids = remap(meal.component_ids, meal.date);
			}
		}
	}
	for (const meal of breakfasts) {
		if (meal.component_ids?.length) {
			meal.component_ids = remap(meal.component_ids, meal.date);
		}
	}
	for (const snack of snackBoxes) {
		if (snack.component_ids?.length) {
			snack.component_ids = remap(snack.component_ids, snack.date);
		}
	}
}

export function splitBatchesByShelfLifeAndReassign(
	batches: MisePlanComponentBatch[],
	mealsByDay: MisePlanDay[],
	breakfasts: MisePlanMeal[],
	snackBoxes: MiseSnackBox[],
): { batches: MisePlanComponentBatch[]; report: RebatchReport } {
	const result = splitBatchesByShelfLife(batches);
	const originalToSplits = new Map<string, MisePlanComponentBatch[]>();
	for (const batch of result.batches) {
		const meta = batch.meta as Record<string, unknown> | undefined;
		const splitFrom = typeof meta?.split_from === "string" ? meta.split_from as string : null;
		// First sub-group keeps the original ID; subsequent ones have split_from set.
		// Group all sub-batches under the original ID.
		const key = splitFrom || batch.id.replace(/_b\d+$/, "");
		if (!originalToSplits.has(key)) originalToSplits.set(key, []);
		originalToSplits.get(key)!.push(batch);
	}
	reassignComponentIdsToSplits(originalToSplits, mealsByDay, breakfasts, snackBoxes);
	return result;
}

export function splitBatchesByShelfLife(batches: MisePlanComponentBatch[]): { batches: MisePlanComponentBatch[]; report: RebatchReport } {
	const report: RebatchReport = { batches_split: 0, batches_rescheduled: 0, notes: [] };
	const out: MisePlanComponentBatch[] = [];

	for (const batch of batches) {
		const shelfHours = batch.quality_window_hours || 96;
		const shelfDays = Math.max(1, Math.floor(shelfHours / 24));
		const uses = [...(batch.planned_uses || [])].sort((a, b) => a.date.localeCompare(b.date));
		if (uses.length <= 1) {
			out.push(batch);
			continue;
		}

		// Walk the uses; start a new sub-group when the gap from the FIRST use of
		// the current group to the candidate next use exceeds shelf life.
		const groups: typeof uses[] = [];
		let group: typeof uses = [];
		for (const use of uses) {
			if (group.length === 0) { group.push(use); continue; }
			const groupStart = group[0].date;
			const span = daysBetween(groupStart, use.date);
			if (span > shelfDays - 1) {
				// span exceeds shelf life — start new group
				groups.push(group);
				group = [use];
			} else {
				group.push(use);
			}
		}
		if (group.length > 0) groups.push(group);

		if (groups.length === 1) {
			out.push(batch);
			continue;
		}

		// Split required.
		report.batches_split += groups.length - 1;
		report.notes.push(`${batch.label}: ${uses.length} uses across ${daysBetween(uses[0].date, uses[uses.length - 1].date)} days exceeds ${shelfHours}h fridge — split into ${groups.length} batches`);

		groups.forEach((groupUses, index) => {
			const suffix = index === 0 ? "" : `_b${index + 1}`;
			const newId = `${batch.id}${suffix}`;
			out.push({
				...batch,
				id: newId,
				planned_uses: groupUses,
				meta: {
					...batch.meta,
					split_from: index === 0 ? undefined : batch.id,
					split_index: index,
					split_total: groups.length,
				},
			});
		});
	}

	return { batches: out, report };
}

export function assignDesiredPrepDates(batches: MisePlanComponentBatch[], startDate: string): RebatchReport {
	const report: RebatchReport = { batches_split: 0, batches_rescheduled: 0, notes: [] };
	for (const batch of batches) {
		const formula = (batch.meta as Record<string, unknown> | undefined)?.formula as MiseFormula | undefined;
		const uses = [...(batch.planned_uses || [])].sort((a, b) => a.date.localeCompare(b.date));
		if (uses.length === 0) continue;

		const firstUse = uses[0].date;
		const lastUse = uses[uses.length - 1].date;
		// Default rule: prep 1 day before first use, but slide based on formula
		// hints. Make-ahead-best-min/max gives us the SWEET spot range.
		const idealLead = clampInt(formula?.make_ahead_best_max, 1, 4) ?? 1;
		const minLead = clampInt(formula?.make_ahead_best_min, 0, 3) ?? 0;
		// idle_time_min in hours covers things like dough cold-ferment or chia
		// pudding setting time — push prep earlier so the idle finishes before
		// first use.
		const idleHours = (formula?.idle_time_min ?? 0) / 60;
		const idleDays = Math.ceil(idleHours / 24);
		const requiredLead = Math.max(idleDays, minLead);
		const shelfHours = batch.quality_window_hours || 96;
		const useSpanHours = Math.max(0, daysBetween(firstUse, lastUse) * 24);
		const maxLeadInsideShelf = Math.max(0, Math.floor((shelfHours - useSpanHours) / 24));
		const lead = maxLeadInsideShelf >= requiredLead
			? Math.min(Math.max(idealLead, requiredLead), maxLeadInsideShelf)
			: requiredLead;

		let desired = subtractDays(firstUse, lead);
		// Clamp to plan start date — never prep before the plan begins
		if (desired < startDate) desired = startDate;

		batch.meta = { ...batch.meta, desired_prep_date: desired };
		report.batches_rescheduled++;
	}
	return report;
}

function daysBetween(a: string, b: string): number {
	const da = new Date(a + "T00:00:00Z").getTime();
	const db = new Date(b + "T00:00:00Z").getTime();
	return Math.round((db - da) / DAY_MS);
}

function subtractDays(iso: string, days: number): string {
	const d = new Date(iso + "T00:00:00Z");
	d.setUTCDate(d.getUTCDate() - days);
	return d.toISOString().slice(0, 10);
}

function clampInt(value: number | null | undefined, min: number, max: number): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.max(min, Math.min(max, Math.floor(value)));
}
