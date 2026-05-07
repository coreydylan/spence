// U53 — Equipment claim atomicity + conflict detection.
//
// Defines a kitchen with one oven (exclusive) + a 4-burner stove (shared,
// capacity 4) and exercises the conflict detector:
//   1. Two non-overlapping oven claims both succeed.
//   2. An overlapping oven claim conflicts and reports the existing claim.
//   3. all_or_nothing: if ANY claim in the batch conflicts, NONE are written.
//   4. Shared resource (stove) accepts up to capacity; the (capacity+1)-th
//      overlapping claim conflicts.
//   5. Within a single batch, two requested claims for the same exclusive
//      resource overlap → second one conflicts (in-flight detection).

import type { Scenario } from "../lib/types";
import {
	claimEquipment,
	defineEquipment,
	listEquipment,
} from "../../src/mise-graph/equipment";
import { EquipmentFakeD1 } from "../lib/wave7c-fake-d1";

const HH = "hh_u53";
const HOUR = 60 * 60_000;

const u53: Scenario = {
	id: "u53",
	name: "Equipment: atomic claim + interval-overlap conflict + all_or_nothing semantics",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const db = new EquipmentFakeD1();
		const env = { DB: db as unknown as D1Database };

		// ── 0. Define resources ────────────────────────────────────────────
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
		const defs = await listEquipment(env, HH);
		ctx.assert.eq(defs.length, 2, "two equipment definitions registered");
		const ovenDef = defs.find(d => d.slug === "oven_main")!;
		ctx.assert.ok(ovenDef.exclusive, "oven is exclusive");
		const stoveDef = defs.find(d => d.slug === "stove_top")!;
		ctx.assert.eq(stoveDef.capacity, 4, "stove has capacity 4");

		// ── 1. Two non-overlapping oven claims both succeed ────────────────
		const baseTs = 1746_500_000_000;  // arbitrary fixed ms epoch
		const r1 = await claimEquipment(env, {
			household_id: HH,
			claims: [{
				equipment_slug: "oven_main",
				claim_for: { kind: "meal", id: "meal_a" },
				start_ts: baseTs,
				end_ts: baseTs + HOUR,
				claimed_by: "alice",
			}],
		});
		ctx.assert.ok(r1.ok, "first oven claim succeeds");
		ctx.assert.eq(r1.granted.length, 1, "one claim granted");
		ctx.assert.eq(r1.conflicts.length, 0, "no conflicts");

		const r2 = await claimEquipment(env, {
			household_id: HH,
			claims: [{
				equipment_slug: "oven_main",
				claim_for: { kind: "meal", id: "meal_b" },
				start_ts: baseTs + HOUR,
				end_ts: baseTs + 2 * HOUR,
				claimed_by: "alice",
			}],
		});
		ctx.assert.ok(r2.ok, "back-to-back oven claim (touching, not overlapping) succeeds");
		ctx.assert.eq(r2.granted.length, 1, "second non-overlapping claim granted");

		// ── 2. Overlapping oven claim conflicts ────────────────────────────
		const r3 = await claimEquipment(env, {
			household_id: HH,
			claims: [{
				equipment_slug: "oven_main",
				claim_for: { kind: "meal", id: "meal_c" },
				start_ts: baseTs + 30 * 60_000,            // mid-r1 window
				end_ts: baseTs + 90 * 60_000,
				claimed_by: "bobby",
			}],
		});
		ctx.assert.ok(!r3.ok, "overlapping claim is NOT ok");
		ctx.assert.eq(r3.granted.length, 0, "no claim granted on overlap");
		ctx.assert.eq(r3.conflicts.length, 1, "one conflict reported");
		ctx.assert.gte(
			r3.conflicts[0].conflicts_with.length,
			1,
			"conflict reports at least one existing claim",
		);
		ctx.assert.eq(
			r3.conflicts[0].conflicts_with[0].claim_for.id,
			"meal_a",
			"conflict points back to meal_a's claim",
		);

		// ── 3. all_or_nothing: any conflict aborts the batch ──────────────
		const r4 = await claimEquipment(env, {
			household_id: HH,
			all_or_nothing: true,
			claims: [
				// Would succeed alone:
				{
					equipment_slug: "oven_main",
					claim_for: { kind: "meal", id: "meal_d_part1" },
					start_ts: baseTs + 4 * HOUR,
					end_ts: baseTs + 5 * HOUR,
					claimed_by: "alice",
				},
				// Conflicts with r1:
				{
					equipment_slug: "oven_main",
					claim_for: { kind: "meal", id: "meal_d_part2" },
					start_ts: baseTs + 30 * 60_000,
					end_ts: baseTs + 90 * 60_000,
					claimed_by: "alice",
				},
			],
		});
		ctx.assert.ok(!r4.ok, "all_or_nothing batch rejected on conflict");
		ctx.assert.eq(r4.granted.length, 0, "no claims persisted in atomic batch");

		// Verify nothing was written: claim count for oven_main is still 2.
		const ovenClaims = [...db.claims.values()].filter(c => c.equipment_slug === "oven_main");
		ctx.assert.eq(ovenClaims.length, 2, "oven still has only the two original claims (atomic abort)");

		// ── 4. Shared resource: capacity gate ──────────────────────────────
		const stoveStart = baseTs + 6 * HOUR;
		const stoveEnd = stoveStart + HOUR;
		// Fill all 4 burners simultaneously.
		const fill = await claimEquipment(env, {
			household_id: HH,
			claims: [
				{ equipment_slug: "stove_top", claim_for: { kind: "task", id: "t1" }, start_ts: stoveStart, end_ts: stoveEnd, claimed_by: "alice" },
				{ equipment_slug: "stove_top", claim_for: { kind: "task", id: "t2" }, start_ts: stoveStart, end_ts: stoveEnd, claimed_by: "alice" },
				{ equipment_slug: "stove_top", claim_for: { kind: "task", id: "t3" }, start_ts: stoveStart, end_ts: stoveEnd, claimed_by: "alice" },
				{ equipment_slug: "stove_top", claim_for: { kind: "task", id: "t4" }, start_ts: stoveStart, end_ts: stoveEnd, claimed_by: "alice" },
			],
		});
		ctx.assert.ok(fill.ok, "filling capacity-4 stove with 4 simultaneous claims is fine");
		ctx.assert.eq(fill.granted.length, 4, "all 4 burners granted");

		// 5th overlapping claim conflicts.
		const overflow = await claimEquipment(env, {
			household_id: HH,
			claims: [{
				equipment_slug: "stove_top",
				claim_for: { kind: "task", id: "t5" },
				start_ts: stoveStart + 5 * 60_000,
				end_ts: stoveEnd + 10 * 60_000,
				claimed_by: "alice",
			}],
		});
		ctx.assert.ok(!overflow.ok, "5th burner claim conflicts on capacity gate");
		ctx.assert.eq(overflow.conflicts.length, 1, "overflow conflict reported");

		// ── 5. In-flight conflict within a single batch ────────────────────
		const inflightStart = baseTs + 10 * HOUR;
		const inflight = await claimEquipment(env, {
			household_id: HH,
			claims: [
				{
					equipment_slug: "oven_main",
					claim_for: { kind: "meal", id: "meal_e1" },
					start_ts: inflightStart,
					end_ts: inflightStart + HOUR,
					claimed_by: "alice",
				},
				// Overlaps the first within the same batch — should conflict
				// even though no DB row exists yet for the first.
				{
					equipment_slug: "oven_main",
					claim_for: { kind: "meal", id: "meal_e2" },
					start_ts: inflightStart + 30 * 60_000,
					end_ts: inflightStart + 90 * 60_000,
					claimed_by: "alice",
				},
			],
		});
		ctx.assert.ok(!inflight.ok, "in-flight overlap within a single batch is rejected");
		ctx.assert.eq(inflight.conflicts.length, 1, "second claim is the conflicting one");
		ctx.assert.eq(inflight.granted.length, 1, "first claim still granted (no all_or_nothing)");

		ctx.notes.push(`oven claims persisted: ${ovenClaims.length}`);
		ctx.notes.push(`stove claims persisted: ${[...db.claims.values()].filter(c => c.equipment_slug === "stove_top").length}`);
	},
};

export default u53;
