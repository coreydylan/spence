// T4 — Shelf-life rebatch with date sliding.
//
// Builds a synthetic component batch with 12 planned uses spread across a
// 14-day window (well beyond a 96h shelf), runs splitBatchesByShelfLife,
// asserts that:
//   - The batch is split into ≥3 sub-batches
//   - Each sub-batch's planned_uses span fits within shelf life
//   - No sub-batch is empty (no orphans)
//   - Total uses preserved (no double-count, no loss)
//
// Then runs assignDesiredPrepDates and asserts each sub-batch has a
// desired_prep_date close to its first use.

import type { Scenario } from "../lib/types";
import { splitBatchesByShelfLife, assignDesiredPrepDates } from "../../src/mise-graph/shelf-life-rebatch";
import type { MisePlanComponentBatch } from "../../src/mise-graph/planner";

const t04: Scenario = {
	id: "t04",
	name: "Shelf-life rebatch splits, slides prep, leaves no orphans",
	group: "ripple",
	tier: "fast",
	async run(ctx) {
		// Build a synthetic Hummus batch with 12 uses across 14 days.
		// 96h fridge shelf — should split into roughly 3-4 sub-batches.
		const useDates = [
			"2026-05-11", "2026-05-12", "2026-05-13",   // group 1 (within 96h)
			"2026-05-14", "2026-05-15", "2026-05-16",   // group 2
			"2026-05-17", "2026-05-18",                  // group 3
			"2026-05-21", "2026-05-22",                  // group 4
			"2026-05-23", "2026-05-24",                  // group 4 cont.
		];
		const batch: MisePlanComponentBatch = {
			id: "mise_component:hummus",
			state_id: null,
			label: "Hummus",
			quantity: 500,
			unit: "g",
			storage: "refrigerator",
			container: null,
			quality_window_hours: 96,
			planned_uses: useDates.map((d, i) => ({
				date: d,
				slot: i % 3 === 0 ? "snack" : (i % 2 === 0 ? "lunch" : "dinner"),
				meal_id: `meal:test_${i}`,
				title: `Test meal ${i}`,
			})),
			station_tags: ["sauce_active"],
			equipment: ["food processor"],
			active_time_min: 12,
			idle_time_min: 0,
			input_names: ["chickpea", "tahini", "lemon juice", "garlic"],
			meta: { source: "synthetic_test" },
		};

		// Run the split
		const result = splitBatchesByShelfLife([batch]);
		ctx.notes.push(`splits: ${result.report.batches_split}`);
		ctx.notes.push(`output batches: ${result.batches.length}`);

		ctx.assert.gte(result.batches.length, 3, "batch splits into ≥3 sub-batches given 12 uses over 14 days at 96h shelf");
		ctx.assert.gt(result.report.batches_split, 0, "rebatch report shows splits performed");

		// Each batch's planned_uses span fits shelf life
		for (const sub of result.batches) {
			const dates = sub.planned_uses.map(u => u.date).sort();
			const spanDays = daysBetween(dates[0], dates[dates.length - 1]);
			ctx.assert.lte(spanDays, 4, `sub-batch ${sub.id} span ${spanDays}d fits within 96h shelf`);
			ctx.assert.gt(sub.planned_uses.length, 0, `sub-batch ${sub.id} has ≥1 planned use (no orphan)`);
		}

		// Total uses preserved
		const totalUses = result.batches.reduce((sum, b) => sum + b.planned_uses.length, 0);
		ctx.assert.eq(totalUses, useDates.length, `total planned_uses preserved: ${totalUses} === ${useDates.length}`);

		// Assign desired prep dates
		const prepReport = assignDesiredPrepDates(result.batches, "2026-05-11");
		ctx.assert.eq(prepReport.batches_rescheduled, result.batches.length, "every sub-batch got a desired_prep_date");

		// Each desired_prep_date is on or before the first use
		for (const sub of result.batches) {
			const meta = sub.meta as Record<string, unknown>;
			const desired = meta.desired_prep_date as string;
			const firstUse = sub.planned_uses[0].date;
			ctx.assert.lte(desired, firstUse, `sub-batch ${sub.id} prep ${desired} ≤ first use ${firstUse}`);
		}
	},
};

function daysBetween(a: string, b: string): number {
	const da = new Date(a + "T00:00:00Z").getTime();
	const db = new Date(b + "T00:00:00Z").getTime();
	return Math.round((db - da) / 86400000);
}

export default t04;
