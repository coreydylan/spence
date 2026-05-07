// U1 — ResourceLedger basics: shop receive, meal consume, expiry sweep.
//
// Exercises the core read/mutation API against a small synthetic event
// stream. No fixtures, no plan import — just direct event application.

import type { Scenario } from "../lib/types";
import {
	createLedger,
	type LedgerEvent,
	type ResourceItem,
} from "../../src/mise-graph/resource-ledger";

const u01: Scenario = {
	id: "u01",
	name: "ResourceLedger applies shop/meal events and tracks expiry",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// 1. Empty ledger.
		const empty = createLedger();
		ctx.assert.eq(empty.at("2026-05-12").length, 0, "empty ledger has no items at any date");
		ctx.assert.eq(empty.events().length, 0, "empty ledger has no events");

		// 2. Apply shop_received with 250g shiitake expiring 2026-05-15.
		const shiitake: ResourceItem = {
			canonical_name: "shiitake mushroom",
			qty: 250,
			unit: "g",
			available_from: "2026-05-11",
			expires_at: "2026-05-15",
			source: { kind: "shop_trip", trip_id: "trip_a", purchased_on: "2026-05-11" },
		};
		const shopEvent: LedgerEvent = {
			kind: "shop_received",
			on_date: "2026-05-11",
			trip_id: "trip_a",
			items: [shiitake],
		};
		const stocked = empty.apply(shopEvent);
		ctx.assert.eq(stocked.events().length, 1, "stocked ledger has 1 event");
		const day12 = stocked.at("2026-05-12");
		ctx.assert.eq(day12.length, 1, "shiitake visible at 2026-05-12 after shop on 2026-05-11");
		ctx.assert.eq(day12[0].qty, 250, "qty preserved");
		ctx.assert.eq(stocked.available_qty("Shiitake Mushroom", "2026-05-12"), 250, "available_qty matches case-insensitively");

		// 3. Consume 200g via meal_consumed.
		const mealEvent: LedgerEvent = {
			kind: "meal_consumed",
			on_date: "2026-05-12",
			meal_id: "meal:tuesday_dinner",
			consumes: [{
				canonical_name: "shiitake mushroom",
				qty: 200,
				unit: "g",
				available_from: "2026-05-12",
				expires_at: null,
				source: { kind: "pantry", stocked_qty: 200 },
			}],
		};
		const afterMeal = stocked.apply(mealEvent);
		const day13 = afterMeal.at("2026-05-13");
		ctx.assert.eq(day13.length, 1, "one shiitake lot remains after meal consumption");
		ctx.assert.eq(day13[0].qty, 50, "50g shiitake remaining after consuming 200g of 250g");

		// 4. consumed_at on the meal date returns the consumption record.
		const consumedToday = afterMeal.consumed_at("2026-05-12");
		ctx.assert.eq(consumedToday.length, 1, "one consumption record on 2026-05-12");
		ctx.assert.eq(consumedToday[0].qty, 200, "consumed 200g matches meal request");

		// 5. expiring_by — within 1 day on 2026-05-15 should include shiitake (expires 2026-05-15)
		// from a date that's still "current" relative to expiry.
		const expiringSoon = afterMeal.expiring_by("2026-05-14", 1);
		ctx.assert.eq(expiringSoon.length, 1, "shiitake expiring within 1 day of 2026-05-14 (expires 2026-05-15)");

		// On 2026-05-12 with threshold 0, expiry is 3 days away → not flagged
		const notExpiring = afterMeal.expiring_by("2026-05-12", 0);
		ctx.assert.eq(notExpiring.length, 0, "shiitake not flagged with threshold 0 on 2026-05-12");

		// 6. Apply explicit expired event; remaining 50g should drop to 0.
		const expiredEvent: LedgerEvent = {
			kind: "expired",
			on_date: "2026-05-15",
			item_canonical: "shiitake mushroom",
			qty: 50,
		};
		const afterExpiry = afterMeal.apply(expiredEvent);
		ctx.assert.eq(afterExpiry.available_qty("shiitake mushroom", "2026-05-15"), 0, "shiitake fully expired");
		ctx.assert.eq(afterExpiry.at("2026-05-16").length, 0, "no shiitake remains after expired event");

		// 7. Immutability: original ledger unchanged.
		ctx.assert.eq(afterMeal.available_qty("shiitake mushroom", "2026-05-13"), 50,
			"original ledger unchanged after apply (immutability)");

		// 8. apply_many works.
		const ledger2 = createLedger().apply_many([shopEvent, mealEvent]);
		ctx.assert.eq(ledger2.events().length, 2, "apply_many appends both events");
		ctx.assert.eq(ledger2.available_qty("shiitake mushroom", "2026-05-13"), 50, "apply_many produces same state");

		// 9. waste_at_end — if we never consume any, full qty shows as waste at end_date past expiry.
		const onlyShop = createLedger().apply(shopEvent);
		const waste = onlyShop.waste_at_end("2026-05-20");
		ctx.assert.eq(waste.length, 1, "unconsumed shiitake projected as waste past end date");
		ctx.assert.eq(waste[0].qty, 250, "full 250g flagged as waste");

		ctx.notes.push(`u01 events applied; final shiitake qty = 0 after expiry`);
	},
};

export default u01;
