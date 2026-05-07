// U25 — Kitchen inventory: add/list/consume/expiringSoon/reconcileWithShopRun.
//
// Verifies the persistent kitchen-state layer separate from week-plan
// pantry lists.

import type { Scenario } from "../lib/types";
import { createMockD1 } from "../lib/mock-d1";
import { migrateHouseholdMemorySchema } from "../../src/mise-graph/admin-household-memory";
import {
	addItem,
	listInventory,
	consumeItem,
	expiringSoon,
	reconcileWithShopRun,
} from "../../src/mise-graph/kitchen-inventory";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

const u25: Scenario = {
	id: "u25",
	name: "Kitchen inventory: add/consume/expire/reconcile",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const db = createMockD1();
		const env = { DB: db as unknown as D1Database } as MiseGraphEnv;
		await migrateHouseholdMemorySchema(env);

		const today = new Date();
		const isoIn = (days: number): string => {
			const d = new Date(today);
			d.setUTCDate(d.getUTCDate() + days);
			return d.toISOString().slice(0, 10);
		};

		// 1. addItem + listInventory round-trip.
		const olive = await addItem(env, {
			household_id: "hh_a",
			canonical_name: "olive oil",
			qty: 1,
			unit: "bottle",
			storage: "pantry",
			acquired_at: isoIn(0),
			expires_at: null,
			source: "observation",
			notes: null,
		});
		ctx.assert.ok(olive.inventory_id.length > 0, "addItem returns inventory_id");
		ctx.assert.eq(olive.consumed, false, "newly added item is not consumed");

		const tofu = await addItem(env, {
			household_id: "hh_a",
			canonical_name: "tofu",
			qty: 2,
			unit: "block",
			storage: "fridge",
			acquired_at: isoIn(0),
			expires_at: isoIn(3),
			source: "shop_run",
			notes: null,
		});

		const items = await listInventory(env, "hh_a");
		ctx.assert.eq(items.length, 2, "listInventory returns both items");
		ctx.assert.ok(items.every(i => i.consumed === false), "default list excludes consumed items");

		// 2. consumeItem flips the flag (no qty → fully consumed).
		await consumeItem(env, olive.inventory_id);
		const afterConsume = await listInventory(env, "hh_a");
		ctx.assert.eq(afterConsume.length, 1, "consumed item filtered from default list");
		ctx.assert.eq(afterConsume[0].canonical_name, "tofu", "remaining item is tofu");

		// Including consumed:
		const all = await listInventory(env, "hh_a", { include_consumed: true });
		ctx.assert.eq(all.length, 2, "include_consumed returns both");

		// Partial consume on tofu (1 of 2 blocks).
		const tofuAfter = await consumeItem(env, tofu.inventory_id, 1);
		ctx.assert.eq(tofuAfter.qty, 1, "partial consume reduces qty");
		ctx.assert.eq(tofuAfter.consumed, false, "partial consume keeps consumed=false");

		// Full consume of remaining 1 block.
		const tofuFully = await consumeItem(env, tofu.inventory_id, 1);
		ctx.assert.eq(tofuFully.consumed, true, "full consume flips flag");

		// 3. expiringSoon filters by date threshold.
		const milk = await addItem(env, {
			household_id: "hh_a",
			canonical_name: "milk",
			qty: 1,
			unit: "gallon",
			storage: "fridge",
			acquired_at: isoIn(0),
			expires_at: isoIn(2),
			source: "shop_run",
			notes: null,
		});
		await addItem(env, {
			household_id: "hh_a",
			canonical_name: "frozen peas",
			qty: 1,
			unit: "bag",
			storage: "freezer",
			acquired_at: isoIn(0),
			expires_at: isoIn(60),
			source: "shop_run",
			notes: null,
		});
		await addItem(env, {
			household_id: "hh_a",
			canonical_name: "salt",
			qty: 1,
			unit: "box",
			storage: "pantry",
			acquired_at: isoIn(0),
			expires_at: null,
			source: "observation",
			notes: null,
		});

		const within3 = await expiringSoon(env, "hh_a", 3);
		ctx.assert.eq(within3.length, 1, "only milk expires within 3 days");
		ctx.assert.eq(within3[0].canonical_name, "milk", "milk surfaces as expiring");

		const within90 = await expiringSoon(env, "hh_a", 90);
		ctx.assert.eq(within90.length, 2, "milk + frozen peas expire within 90 days (salt has no expiry)");

		// Consumed items should not appear in expiringSoon.
		await consumeItem(env, milk.inventory_id);
		const after = await expiringSoon(env, "hh_a", 3);
		ctx.assert.eq(after.length, 0, "consumed milk no longer in expiringSoon");

		// 4. reconcileWithShopRun adds new and matches existing.
		const recon = await reconcileWithShopRun(env, "hh_a", [
			{ name: "salt", qty: 1, unit: "box" },     // matches existing (salt is un-consumed)
			{ name: "almonds", qty: 200, unit: "g" }, // new
			{ name: "frozen peas", qty: 1, unit: "bag" }, // matches existing
		]);
		ctx.assert.eq(recon.added, 1, "one new item added (almonds)");
		ctx.assert.eq(recon.matched, 2, "two existing items matched (salt + frozen peas)");

		const finalList = await listInventory(env, "hh_a");
		// Active items so far: tofu was fully consumed, olive consumed, milk consumed,
		// remaining: frozen peas, salt, almonds = 3.
		ctx.assert.eq(finalList.length, 3, "final un-consumed list is 3 items");
		const salt = finalList.find(i => i.canonical_name === "salt");
		ctx.assert.eq(salt?.qty, 2, "salt qty incremented from reconcile (1 + 1)");

		ctx.notes.push(`u25 final inventory size = ${finalList.length}`);
	},
};

export default u25;
