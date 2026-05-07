// U28 — eventToMutations: pure translation from life events to world-model
// mutations. Verifies that:
//   - skip_meal becomes a single cancel_meal mutation with the right slot
//   - move_meal preserves from/to/mode in the mutation
//   - skip_shop returns an empty array (handled as direct edit, not mutation)
//   - change_anchors returns an empty array (handled at plan-edit level)

import type { Scenario } from "../lib/types";
import { eventToMutations, type ReplanEvent } from "../../src/mise-graph/replan-events";

const u28: Scenario = {
	id: "u28",
	name: "Replan event-to-mutation translation: skip_meal, move_meal, skip_shop, change_anchors",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// (1) skip_meal → [cancel_meal { slot }]
		const skip: ReplanEvent = {
			kind: "skip_meal",
			slot: { date: "2026-05-13", slot: "dinner" },
			reason: "going out",
		};
		const skipMuts = eventToMutations(skip);
		ctx.assert.eq(skipMuts.length, 1, "skip_meal yields one mutation");
		ctx.assert.eq(skipMuts[0].kind, "cancel_meal", "skip_meal mutation is cancel_meal");
		if (skipMuts[0].kind === "cancel_meal") {
			ctx.assert.eq(skipMuts[0].slot.date, "2026-05-13", "cancel_meal carries date");
			ctx.assert.eq(skipMuts[0].slot.slot, "dinner", "cancel_meal carries slot");
		}

		// (2) move_meal → [move_meal { from, to, mode }]
		const move: ReplanEvent = {
			kind: "move_meal",
			from: { date: "2026-05-13", slot: "dinner" },
			to: { date: "2026-05-14", slot: "dinner" },
			mode: "swap",
		};
		const moveMuts = eventToMutations(move);
		ctx.assert.eq(moveMuts.length, 1, "move_meal yields one mutation");
		ctx.assert.eq(moveMuts[0].kind, "move_meal", "move_meal mutation kind matches");
		if (moveMuts[0].kind === "move_meal") {
			ctx.assert.eq(moveMuts[0].from.date, "2026-05-13", "move from date carried");
			ctx.assert.eq(moveMuts[0].to.date, "2026-05-14", "move to date carried");
			ctx.assert.eq(moveMuts[0].mode, "swap", "move mode preserved");
		}

		// (2b) move_meal without explicit mode defaults to "replace"
		const moveDefault: ReplanEvent = {
			kind: "move_meal",
			from: { date: "2026-05-13", slot: "dinner" },
			to: { date: "2026-05-14", slot: "dinner" },
		};
		const moveDefaultMuts = eventToMutations(moveDefault);
		if (moveDefaultMuts[0].kind === "move_meal") {
			ctx.assert.eq(moveDefaultMuts[0].mode, "replace", "default mode is replace");
		}

		// (3) skip_shop → empty array (direct edit territory)
		const skipShop: ReplanEvent = { kind: "skip_shop", run_id: "run:wed" };
		ctx.assert.eq(eventToMutations(skipShop).length, 0, "skip_shop translates to no mutations");

		// (4) change_anchors → empty (plan-metadata edit)
		const changeAnchors: ReplanEvent = {
			kind: "change_anchors",
			add: ["tofu"],
			remove: ["chickpea"],
		};
		ctx.assert.eq(eventToMutations(changeAnchors).length, 0, "change_anchors yields zero mutations");

		// (5) move_shop → [move_shop]
		const moveShop: ReplanEvent = { kind: "move_shop", run_id: "run:wed", new_date: "2026-05-14" };
		const moveShopMuts = eventToMutations(moveShop);
		ctx.assert.eq(moveShopMuts.length, 1, "move_shop yields one mutation");
		ctx.assert.eq(moveShopMuts[0].kind, "move_shop", "move_shop mutation kind matches");

		// (6) Plan-metadata events all return empty arrays
		const directEdits: ReplanEvent[] = [
			{ kind: "add_meal", slot: { date: "2026-05-15", slot: "lunch" } },
			{ kind: "cancel_cook", cook_id: "task:1" },
			{ kind: "move_cook", cook_id: "task:1", new_date: "2026-05-14" },
			{ kind: "change_people", new_count: 3 },
			{ kind: "lock_slot", slot: { date: "2026-05-13", slot: "dinner" }, reason: "favorite" },
			{ kind: "mark_cooked", slot: { date: "2026-05-13", slot: "dinner" } },
			{ kind: "report_inventory", items: [{ canonical_name: "tofu", qty: 200, unit: "g" }] },
		];
		for (const ev of directEdits) {
			ctx.assert.eq(eventToMutations(ev).length, 0, `${ev.kind} translates to zero mutations`);
		}
	},
};

export default u28;
