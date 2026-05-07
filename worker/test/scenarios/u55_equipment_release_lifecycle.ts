// U55 — Equipment release lifecycle.
//
// 1. claim → release a single claim → that slot frees up for a new claim.
// 2. claim three for one meal → releaseClaimsFor(meal:m1) frees all three.
// 3. Re-releasing an already-released claim is a no-op (count=0).
// 4. Released claims don't show up in load reports.

import type { Scenario } from "../lib/types";
import {
	claimEquipment,
	defineEquipment,
	getEquipmentLoad,
	releaseClaimsFor,
	releaseEquipment,
} from "../../src/mise-graph/equipment";
import { EquipmentFakeD1 } from "../lib/wave7c-fake-d1";

const HH = "hh_u55";
const HOUR = 60 * 60_000;

const u55: Scenario = {
	id: "u55",
	name: "Equipment: release lifecycle (single + bulk-by-claim_for) frees the slot",
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

		const t0 = 1746_500_000_000;

		// ── 1. Claim, release, reclaim ─────────────────────────────────────
		const c1 = await claimEquipment(env, {
			household_id: HH,
			claims: [{
				equipment_slug: "oven_main",
				claim_for: { kind: "meal", id: "m1" },
				start_ts: t0,
				end_ts: t0 + 2 * HOUR,
				claimed_by: "alice",
			}],
		});
		ctx.assert.ok(c1.ok, "first claim ok");
		const claim1Id = c1.granted[0].id;

		// Conflict check before release.
		const reclaim = await claimEquipment(env, {
			household_id: HH,
			claims: [{
				equipment_slug: "oven_main",
				claim_for: { kind: "meal", id: "m2" },
				start_ts: t0 + 30 * 60_000,
				end_ts: t0 + 90 * 60_000,
				claimed_by: "alice",
			}],
		});
		ctx.assert.ok(!reclaim.ok, "overlapping reclaim conflicts before release");

		// Release.
		await releaseEquipment(env, claim1Id);
		const released = db.claims.get(claim1Id);
		ctx.assert.ok(!!released, "released claim row still exists");
		ctx.assert.eq(released!.status, "released", "claim status flipped to released");
		ctx.assert.ok(typeof released!.released_at_ms === "number", "released_at_ms stamped");

		// Reclaim succeeds.
		const reclaim2 = await claimEquipment(env, {
			household_id: HH,
			claims: [{
				equipment_slug: "oven_main",
				claim_for: { kind: "meal", id: "m2" },
				start_ts: t0 + 30 * 60_000,
				end_ts: t0 + 90 * 60_000,
				claimed_by: "alice",
			}],
		});
		ctx.assert.ok(reclaim2.ok, "after release, the slot is free again");
		ctx.assert.eq(reclaim2.granted.length, 1, "reclaim is granted");

		// ── 2. Bulk release by claim_for ──────────────────────────────────
		await defineEquipment(env, {
			slug: "burner_1",
			kind: "stove_burner",
			household_id: HH,
			exclusive: true,
		});
		await defineEquipment(env, {
			slug: "burner_2",
			kind: "stove_burner",
			household_id: HH,
			exclusive: true,
		});
		await defineEquipment(env, {
			slug: "knife_8",
			kind: "chefs_knife",
			household_id: HH,
			exclusive: true,
		});

		const bulkStart = t0 + 6 * HOUR;
		const bulk = await claimEquipment(env, {
			household_id: HH,
			claims: [
				{ equipment_slug: "burner_1", claim_for: { kind: "meal", id: "bulk_meal" }, start_ts: bulkStart, end_ts: bulkStart + HOUR, claimed_by: "alice" },
				{ equipment_slug: "burner_2", claim_for: { kind: "meal", id: "bulk_meal" }, start_ts: bulkStart, end_ts: bulkStart + HOUR, claimed_by: "alice" },
				{ equipment_slug: "knife_8", claim_for: { kind: "meal", id: "bulk_meal" }, start_ts: bulkStart, end_ts: bulkStart + 30 * 60_000, claimed_by: "alice" },
			],
		});
		ctx.assert.ok(bulk.ok, "all three bulk claims granted");
		ctx.assert.eq(bulk.granted.length, 3, "three claims persisted");

		const releasedCount = await releaseClaimsFor(env, { kind: "meal", id: "bulk_meal" });
		ctx.assert.eq(releasedCount, 3, "releaseClaimsFor returns count released");

		// All three rows now in 'released' status.
		const stillHeld = [...db.claims.values()].filter(
			c => c.claim_for_id === "bulk_meal" && c.status === "held",
		);
		ctx.assert.eq(stillHeld.length, 0, "no held claims remain for bulk_meal");

		// ── 3. Re-releasing is a no-op ─────────────────────────────────────
		const repeat = await releaseClaimsFor(env, { kind: "meal", id: "bulk_meal" });
		ctx.assert.eq(repeat, 0, "second releaseClaimsFor returns 0");

		// ── 4. Released claims invisible to load metric ───────────────────
		const burnerLoad = await getEquipmentLoad(env, {
			household_id: HH,
			equipment_slug: "burner_1",
			window_start_ts: bulkStart,
			window_end_ts: bulkStart + 2 * HOUR,
		});
		ctx.assert.eq(burnerLoad.active_claims.length, 0, "no active claims after release");
		ctx.assert.eq(burnerLoad.load_pct, 0, "load_pct=0 after all claims released");

		// ── 5. Single-release on an already-released id is harmless ───────
		await releaseEquipment(env, claim1Id);
		const stillReleased = db.claims.get(claim1Id);
		ctx.assert.eq(stillReleased!.status, "released", "still released, not flipped");

		ctx.notes.push(`total claim rows: ${db.claims.size}`);
		ctx.notes.push(`released rows: ${[...db.claims.values()].filter(c => c.status === "released").length}`);
	},
};

export default u55;
