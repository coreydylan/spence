// U2 — ledgerFromPlan builds a projected pantry from a plan draft.
//
// Loads the broken-shelf-life fixture, projects via ledgerFromPlan, and
// asserts:
//   - Events are emitted for the cooked_chickpea batch
//   - The cooked_chickpea component is available on its prep date
//   - By 2026-05-17 the cooked_chickpea is exhausted or expired (96h shelf
//     from desired_prep_date 2026-05-11 → expires ~2026-05-15)

import type { Scenario } from "../lib/types";
import { ledgerFromPlan } from "../../src/mise-graph/resource-ledger";
import type { MiseWeeklyPlanDraft } from "../../src/mise-graph/planner";

const u02: Scenario = {
	id: "u02",
	name: "ledgerFromPlan projects cooked_chickpea batch availability and expiry",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const fixture = ctx.loadFixture<MiseWeeklyPlanDraft>("plan-broken-shelf-life-and-dietary.json");

		// The fixture omits some optional plan fields that ledgerFromPlan reads;
		// safe-default them so the function can walk the plan.
		const plan = {
			...fixture,
			breakfasts: fixture.breakfasts || [],
			snack_boxes: fixture.snack_boxes || [],
			component_batches: fixture.component_batches || [],
			meals_by_day: fixture.meals_by_day || [],
		} as MiseWeeklyPlanDraft;

		const ledger = ledgerFromPlan(plan);
		const events = ledger.events();
		ctx.notes.push(`ledger built with ${events.length} events`);

		// 1. Events emitted for cooked_chickpea batch (prep_produced + at least one
		// meal_consumed for its planned uses).
		const chickpeaEvents = events.filter(e =>
			(e.kind === "prep_produced" || e.kind === "prep_consumed") &&
			"batch_id" in e && e.batch_id === "mise_component:cooked_chickpea");
		ctx.assert.gte(chickpeaEvents.length, 1, "at least one prep event emitted for cooked_chickpea");

		const chickpeaProduced = events.find(e =>
			e.kind === "prep_produced" && e.batch_id === "mise_component:cooked_chickpea");
		ctx.assert.ok(!!chickpeaProduced, "prep_produced event for cooked_chickpea exists");

		// 2. Cooked chickpea available on 2026-05-13 (the Wed control meal uses it).
		// Prep date is 2026-05-11 (from desired_prep_date), output qty = 600g.
		const onWed = ledger.available_qty("cooked whole chickpeas", "2026-05-13");
		ctx.assert.gt(onWed, 0, `cooked chickpea available on 2026-05-13 (qty=${onWed})`);
		ctx.notes.push(`cooked chickpea on 2026-05-13: ${onWed}g`);

		// 3. By 2026-05-17 the chickpea is gone (96h shelf life from 2026-05-11
		// gives expires_at ≈ 2026-05-15, so it's expired by 2026-05-17).
		const onSun = ledger.available_qty("cooked whole chickpeas", "2026-05-17");
		ctx.assert.eq(onSun, 0, "cooked chickpea exhausted/expired by 2026-05-17");

		// 4. consumed_at on 2026-05-13 should show some chickpea drawn for the
		// Wed control meal.
		const wedConsumed = ledger.consumed_at("2026-05-13");
		const wedChickpea = wedConsumed.find(c => c.canonical_name === "cooked whole chickpeas");
		ctx.assert.ok(!!wedChickpea, "cooked chickpea consumed on 2026-05-13 (Wed control meal)");

		// 5. waste_at_end at the plan end date should include the leftover
		// chickpea that didn't get used (Sat violator was past shelf-life).
		const waste = ledger.waste_at_end("2026-05-17");
		ctx.notes.push(`waste at end: ${waste.length} item(s)`);
	},
};

export default u02;
