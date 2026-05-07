// U54 — findFreeWindow correctness.
//
// Verifies the gap-finder over an oven timeline with three held claims:
//   * Empty range → returns earliest_ts.
//   * Gap before first claim is big enough → returns earliest_ts.
//   * Gap before first claim too small → walks to the first big-enough gap.
//   * Range that's fully booked → returns null.
//   * Shared resource with capacity > 1 finds windows under capacity.

import type { Scenario } from "../lib/types";
import {
	claimEquipment,
	defineEquipment,
	findFreeWindow,
	getEquipmentLoad,
} from "../../src/mise-graph/equipment";
import { EquipmentFakeD1 } from "../lib/wave7c-fake-d1";

const HH = "hh_u54";
const HOUR = 60 * 60_000;

const u54: Scenario = {
	id: "u54",
	name: "Equipment: findFreeWindow walks the timeline; getEquipmentLoad reports load_pct",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const db = new EquipmentFakeD1();
		const env = { DB: db as unknown as D1Database };

		await defineEquipment(env, {
			slug: "oven_main",
			kind: "oven",
			household_id: HH,
			exclusive: true,
		});
		await defineEquipment(env, {
			slug: "stove_top",
			kind: "stove_burner",
			household_id: HH,
			exclusive: false,
			capacity: 4,
		});

		const t0 = 1746_500_000_000;

		// ── 1. Empty timeline: earliest free start = earliest_ts ──────────
		const empty = await findFreeWindow(env, {
			household_id: HH,
			equipment_slug: "oven_main",
			earliest_ts: t0,
			latest_ts: t0 + 12 * HOUR,
			duration_min: 60,
		});
		ctx.assert.ok(!!empty, "empty timeline returns a window");
		ctx.assert.eq(empty!.start_ts, t0, "earliest free is the earliest_ts itself");

		// ── 2. Place three oven claims with a fixable gap pattern ─────────
		// Claims:  [t0, t0+1h]  ___gap 30min___  [t0+1.5h, t0+3h]  ___gap 2h___ [t0+5h, t0+6h]
		await claimEquipment(env, {
			household_id: HH,
			claims: [
				{ equipment_slug: "oven_main", claim_for: { kind: "meal", id: "m1" }, start_ts: t0, end_ts: t0 + HOUR, claimed_by: "alice" },
				{ equipment_slug: "oven_main", claim_for: { kind: "meal", id: "m2" }, start_ts: t0 + 1.5 * HOUR, end_ts: t0 + 3 * HOUR, claimed_by: "alice" },
				{ equipment_slug: "oven_main", claim_for: { kind: "meal", id: "m3" }, start_ts: t0 + 5 * HOUR, end_ts: t0 + 6 * HOUR, claimed_by: "alice" },
			],
		});

		// ── 3. Need a 60-min window: only the 2hr gap fits ─────────────────
		const sixty = await findFreeWindow(env, {
			household_id: HH,
			equipment_slug: "oven_main",
			earliest_ts: t0,
			latest_ts: t0 + 12 * HOUR,
			duration_min: 60,
		});
		ctx.assert.ok(!!sixty, "60-min window exists in the schedule");
		ctx.assert.eq(
			sixty!.start_ts,
			t0 + 3 * HOUR,
			"60-min window starts right after m2 ends (t0+3h)",
		);

		// ── 4. Need a 30-min window: the in-between 30-min gap fits ────────
		const thirty = await findFreeWindow(env, {
			household_id: HH,
			equipment_slug: "oven_main",
			earliest_ts: t0,
			latest_ts: t0 + 12 * HOUR,
			duration_min: 30,
		});
		ctx.assert.ok(!!thirty, "30-min window exists");
		ctx.assert.eq(
			thirty!.start_ts,
			t0 + HOUR,
			"30-min window starts at t0+1h (gap between m1 and m2)",
		);

		// ── 5. Need 6hr — search range is too short ──────────────────────
		const tooBig = await findFreeWindow(env, {
			household_id: HH,
			equipment_slug: "oven_main",
			earliest_ts: t0,
			latest_ts: t0 + 7 * HOUR,
			duration_min: 360,
		});
		ctx.assert.eq(tooBig, null, "no 6hr window in 7hr range with claims everywhere");

		// ── 6. Shared resource finds windows under capacity ───────────────
		// Fill 3 of 4 burners for the t0..t0+1h window.
		await claimEquipment(env, {
			household_id: HH,
			claims: [
				{ equipment_slug: "stove_top", claim_for: { kind: "task", id: "s1" }, start_ts: t0, end_ts: t0 + HOUR, claimed_by: "alice" },
				{ equipment_slug: "stove_top", claim_for: { kind: "task", id: "s2" }, start_ts: t0, end_ts: t0 + HOUR, claimed_by: "alice" },
				{ equipment_slug: "stove_top", claim_for: { kind: "task", id: "s3" }, start_ts: t0, end_ts: t0 + HOUR, claimed_by: "alice" },
			],
		});
		const burner = await findFreeWindow(env, {
			household_id: HH,
			equipment_slug: "stove_top",
			earliest_ts: t0,
			latest_ts: t0 + 4 * HOUR,
			duration_min: 30,
		});
		ctx.assert.ok(!!burner, "burner free window found under capacity");
		ctx.assert.eq(burner!.start_ts, t0, "even with 3/4 burners busy, the 4th is free immediately");

		// Fill the 4th too — now no shared window is available in t0..t0+1h.
		await claimEquipment(env, {
			household_id: HH,
			claims: [{
				equipment_slug: "stove_top",
				claim_for: { kind: "task", id: "s4" },
				start_ts: t0,
				end_ts: t0 + HOUR,
				claimed_by: "alice",
			}],
		});
		const burnerFull = await findFreeWindow(env, {
			household_id: HH,
			equipment_slug: "stove_top",
			earliest_ts: t0,
			latest_ts: t0 + 2 * HOUR,
			duration_min: 30,
		});
		ctx.assert.ok(!!burnerFull, "after t0+1h the burners are free again");
		ctx.assert.gte(burnerFull!.start_ts, t0 + HOUR, "free window comes after the saturation block");

		// ── 7. Load metric ─────────────────────────────────────────────────
		// Window covering [t0, t0+6h]: 4 of 6 hours have an oven claim
		// (m1=1hr, m2=1.5hr, m3=1hr; total 3.5hr) → load ≈ 3.5/6.
		const load = await getEquipmentLoad(env, {
			household_id: HH,
			equipment_slug: "oven_main",
			window_start_ts: t0,
			window_end_ts: t0 + 6 * HOUR,
		});
		ctx.assert.gte(load.active_claims.length, 3, "all 3 oven claims surface in the load report");
		ctx.assert.gte(load.load_pct, 0.4, "oven load >= 0.4 (3.5/6 hrs claimed)");
		ctx.assert.lte(load.load_pct, 0.7, "oven load <= 0.7 (still has gaps)");

		ctx.notes.push(`60min slot at t0+${(sixty!.start_ts - t0) / HOUR}h`);
		ctx.notes.push(`30min slot at t0+${(thirty!.start_ts - t0) / HOUR}h`);
		ctx.notes.push(`oven load_pct: ${load.load_pct.toFixed(3)}`);
	},
};

export default u54;
