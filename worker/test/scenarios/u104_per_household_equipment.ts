// U104 — Per-household equipment definitions + claims.
//
// Closes the gap where `mise_equipment_definitions.slug` was a global PK and
// `mise_equipment_claims` had no household_id column, so two households'
// "oven_main" entries collided and a claim by household A blocked a claim
// by household B on the same slug.
//
// Schema is now (household_id, slug) for definitions and household_id is a
// claim column. Conflict-detection queries always filter by household_id.
//
// Test plan:
//   1. Two households both define `oven_main` → two definition rows persist
//      (one per household) — they don't collide.
//   2. Household A claims oven_main 17:00–19:00 → granted.
//   3. Household B claims oven_main 18:00–19:00 → ALSO granted (different
//      physical oven, no cross-household conflict).
//   4. Household A re-claims oven_main 18:00–19:00 with the SAME meal_id as
//      step 2 → idempotent (the request "owns" its own existing claim,
//      which is filtered out of the overlap set).
//   5. Household A claims oven_main 18:00–19:00 with a DIFFERENT meal_id →
//      conflict reported (real same-household overlap).
//   6. Release in household A doesn't disturb household B's claim.

import type { Scenario } from "../lib/types";
import {
	claimEquipment,
	defineEquipment,
	getDefinition,
	listEquipment,
	releaseClaimsFor,
} from "../../src/mise-graph/equipment";
import { EquipmentFakeD1 } from "../lib/wave7c-fake-d1";

const HH_A = "hh_u104_a";
const HH_B = "hh_u104_b";
const HOUR = 60 * 60_000;

const u104: Scenario = {
	id: "u104",
	name: "Equipment: per-household scoping (definitions + claims) eliminates cross-household conflicts",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const db = new EquipmentFakeD1();
		const env = { DB: db as unknown as D1Database };

		// ── 1. Two households define the same slug ────────────────────────
		await defineEquipment(env, {
			slug: "oven_main",
			kind: "oven",
			household_id: HH_A,
			exclusive: true,
		});
		await defineEquipment(env, {
			slug: "oven_main",
			kind: "oven",
			household_id: HH_B,
			exclusive: true,
		});
		ctx.assert.eq(db.definitions.size, 2, "both households' oven_main rows persist (composite key)");

		const aDefs = await listEquipment(env, HH_A);
		ctx.assert.eq(aDefs.length, 1, "household A sees its own definition");
		ctx.assert.eq(aDefs[0].slug, "oven_main", "A's slug = oven_main");
		ctx.assert.eq(aDefs[0].household_id, HH_A, "A's row carries A's household_id");

		const bDefs = await listEquipment(env, HH_B);
		ctx.assert.eq(bDefs.length, 1, "household B sees its own definition");
		ctx.assert.eq(bDefs[0].household_id, HH_B, "B's row carries B's household_id");

		// getDefinition is per-household.
		const aGet = await getDefinition(env, { household_id: HH_A, slug: "oven_main" });
		ctx.assert.ok(!!aGet, "A getDefinition resolves");
		ctx.assert.eq(aGet!.household_id, HH_A, "A getDefinition returns A's row");

		const bGet = await getDefinition(env, { household_id: HH_B, slug: "oven_main" });
		ctx.assert.ok(!!bGet, "B getDefinition resolves");
		ctx.assert.eq(bGet!.household_id, HH_B, "B getDefinition returns B's row");

		// Cross-household lookup yields nothing.
		const cMiss = await getDefinition(env, { household_id: "hh_does_not_exist", slug: "oven_main" });
		ctx.assert.eq(cMiss, null, "unknown household sees no definition");

		// ── 2. Household A claims oven_main 17:00–19:00 ───────────────────
		const baseTs = 1746_500_000_000;
		const aClaim = await claimEquipment(env, {
			household_id: HH_A,
			claims: [{
				equipment_slug: "oven_main",
				claim_for: { kind: "meal", id: "meal:hh_a:dinner" },
				start_ts: baseTs,
				end_ts: baseTs + 2 * HOUR,
				claimed_by: "alice",
			}],
		});
		ctx.assert.ok(aClaim.ok, "A's claim ok");
		ctx.assert.eq(aClaim.granted.length, 1, "A's claim granted");
		ctx.assert.eq(aClaim.granted[0].household_id, HH_A, "A's granted claim carries household_id=A");

		// ── 3. Household B claims oven_main overlapping window → also granted
		const bClaim = await claimEquipment(env, {
			household_id: HH_B,
			claims: [{
				equipment_slug: "oven_main",
				claim_for: { kind: "meal", id: "meal:hh_b:dinner" },
				start_ts: baseTs + HOUR,         // overlaps A's window (18:00–19:00)
				end_ts: baseTs + 2 * HOUR,
				claimed_by: "bob",
			}],
		});
		ctx.assert.ok(bClaim.ok, "B's claim ok despite same slug + same window (different household)");
		ctx.assert.eq(bClaim.granted.length, 1, "B's claim granted (no cross-household conflict)");
		ctx.assert.eq(bClaim.conflicts.length, 0, "B sees zero conflicts (A's claim is in a different household)");
		ctx.assert.eq(bClaim.granted[0].household_id, HH_B, "B's granted claim carries household_id=B");

		// Sanity: both claim rows exist.
		const aClaimRows = [...db.claims.values()].filter(c => c.household_id === HH_A);
		const bClaimRows = [...db.claims.values()].filter(c => c.household_id === HH_B);
		ctx.assert.eq(aClaimRows.length, 1, "exactly one A claim row");
		ctx.assert.eq(bClaimRows.length, 1, "exactly one B claim row");

		// ── 4. A re-claims with SAME meal_id → idempotent (own-claim filter)
		const aIdempotent = await claimEquipment(env, {
			household_id: HH_A,
			claims: [{
				equipment_slug: "oven_main",
				claim_for: { kind: "meal", id: "meal:hh_a:dinner" }, // same as step 2
				start_ts: baseTs + HOUR,
				end_ts: baseTs + 2 * HOUR,
				claimed_by: "alice",
			}],
		});
		ctx.assert.ok(aIdempotent.ok, "A re-claim with same meal_id is ok");
		ctx.assert.eq(aIdempotent.conflicts.length, 0, "no conflict against own claim");
		ctx.assert.eq(aIdempotent.granted.length, 1, "self-overlap is granted (idempotent re-claim)");

		// ── 5. A claims oven_main same window with a DIFFERENT meal_id → conflict
		const aConflict = await claimEquipment(env, {
			household_id: HH_A,
			claims: [{
				equipment_slug: "oven_main",
				claim_for: { kind: "meal", id: "meal:hh_a:dinner_alt" },
				start_ts: baseTs + HOUR,
				end_ts: baseTs + 2 * HOUR,
				claimed_by: "alice",
			}],
		});
		ctx.assert.ok(!aConflict.ok, "A's second meal claim conflicts within same household");
		ctx.assert.eq(aConflict.conflicts.length, 1, "exactly one conflict reported");
		ctx.assert.eq(
			aConflict.conflicts[0].conflicts_with[0].household_id,
			HH_A,
			"conflict points back at A's own claim",
		);

		// ── 6. Releasing A's claims doesn't disturb B's ──────────────────
		const aReleased = await releaseClaimsFor(env, {
			household_id: HH_A,
			claim_for: { kind: "meal", id: "meal:hh_a:dinner" },
		});
		ctx.assert.gte(aReleased, 1, "A released at least one claim");

		// B's row still 'held'.
		const bStillHeld = [...db.claims.values()].filter(
			c => c.household_id === HH_B && c.status === "held",
		);
		ctx.assert.eq(bStillHeld.length, 1, "B's claim is still held after A's release");

		// A's row(s) are 'released'.
		const aHeld = [...db.claims.values()].filter(
			c => c.household_id === HH_A && c.status === "held",
		);
		ctx.assert.eq(aHeld.length, 0, "A has no held claims after release");

		// Cross-household releaseClaimsFor with B's id but A's household: no-op.
		const crossRelease = await releaseClaimsFor(env, {
			household_id: HH_A,
			claim_for: { kind: "meal", id: "meal:hh_b:dinner" },
		});
		ctx.assert.eq(crossRelease, 0, "A cannot release B's claim by id (household-scoped)");

		ctx.notes.push(`def rows: ${db.definitions.size}; claim rows: ${db.claims.size}`);
		ctx.notes.push(`A held=${aHeld.length}; B held=${bStillHeld.length}`);
	},
};

export default u104;
