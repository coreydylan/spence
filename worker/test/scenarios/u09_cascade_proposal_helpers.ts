// U9 — cascade-proposal helper round-trips.
//
// Pure unit tests for `proposalToHumanString` and `proposalToMutation`. The
// helpers are the entry points downstream code (revision loop, UI, audit log)
// uses to render or replay a proposal — they have to behave consistently for
// every CascadeProposalKind without ever throwing.

import type { Scenario } from "../lib/types";
import {
	proposalToHumanString,
	proposalToMutation,
	plantSubstitutionFor,
	type CascadeProposal,
	type CascadeProposalKind,
} from "../../src/mise-graph/cascade-proposals";

const u09: Scenario = {
	id: "u09",
	name: "cascade-proposal helpers render and replay every kind",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const slot = { date: "2026-05-13", slot: "dinner" };
		const otherSlot = { date: "2026-05-14", slot: "dinner" };

		const samples: CascadeProposal[] = [
			{
				kind: "swap_ingredient",
				description: "swap fish sauce for soy sauce",
				expected_resolves: ["g1"],
				parameters: { slot, from_name: "fish sauce", to_name: "soy sauce" },
				mutation: { kind: "swap_ingredient", slot, from_name: "fish sauce", to_name: "soy sauce" },
				confidence: 0.8,
			},
			{
				kind: "replace_meal",
				description: "replace the dinner",
				expected_resolves: ["g2"],
				parameters: { slot, must_avoid: ["chickpea"] },
				confidence: 0.6,
			},
			{
				kind: "move_meal",
				description: "move dinner to the next day",
				expected_resolves: ["g3"],
				parameters: { from_slot: slot, to_slot: otherSlot },
				confidence: 0.55,
			},
			{
				kind: "cancel_meal",
				description: "cancel the meal",
				expected_resolves: ["g4"],
				parameters: { slot, reason: "leftover_window violated" },
				confidence: 0.5,
			},
			{
				kind: "add_meal",
				description: "add a Tuesday lunch consuming leftovers",
				expected_resolves: ["g5"],
				parameters: { slot: { date: "2026-05-12", slot: "lunch" }, hint: "consume leftovers" },
				confidence: 0.7,
			},
			{
				kind: "split_batch",
				description: "split chickpea batch",
				expected_resolves: ["g6"],
				parameters: { batch_id: "mise_component:cooked_chickpea", split_at_date: "2026-05-15" },
				mutation: { kind: "split_batch", batch_id: "mise_component:cooked_chickpea", at_date: "2026-05-15" },
				confidence: 0.85,
			},
			{
				kind: "merge_batches",
				description: "merge two chickpea batches",
				expected_resolves: ["g7"],
				parameters: { batch_ids: ["b1", "b2"] },
				confidence: 0.4,
			},
			{
				kind: "slide_prep_date",
				description: "shift batch prep",
				expected_resolves: ["g8"],
				parameters: { batch_id: "b1", new_prep_date: "2026-05-12" },
				confidence: 0.65,
			},
			{
				kind: "move_shop",
				description: "shift shop run",
				expected_resolves: ["g9"],
				parameters: { run_id: "run_0", new_date: "2026-05-15" },
				confidence: 0.8,
			},
			{
				kind: "drop_item_from_shop",
				description: "drop item from run",
				expected_resolves: ["g10"],
				parameters: { run_id: "run_0", item_name: "spinach" },
				confidence: 0.7,
			},
			{
				kind: "add_shop",
				description: "add a refresh run",
				expected_resolves: ["g11"],
				parameters: { date: "2026-05-15", items: ["spinach"] },
				confidence: 0.65,
			},
			{
				kind: "substitute_recipe",
				description: "swap recipe for a stocked alternative",
				expected_resolves: ["g12"],
				parameters: { slot, from_recipe_id: "r_a", to_recipe_id: "r_b" },
				confidence: 0.5,
			},
			{
				kind: "lock_slot",
				description: "freeze pending human review",
				expected_resolves: ["g13"],
				parameters: { slot, reason: "data broken" },
				confidence: 0.5,
			},
		];

		// --- proposalToHumanString -------------------------------------------------
		const seenKinds = new Set<CascadeProposalKind>();
		for (const p of samples) {
			seenKinds.add(p.kind);
			const s = proposalToHumanString(p);
			ctx.assert.ok(typeof s === "string" && s.length > 5, `proposalToHumanString(${p.kind}) returns a non-empty readable string`);
			ctx.assert.contains(s, p.kind, `human string for ${p.kind} mentions its kind`);
		}
		ctx.assert.eq(seenKinds.size, samples.length, "every sample uses a distinct kind");

		// --- proposalToMutation ----------------------------------------------------
		// lock_slot is informational — never produces a mutation.
		const lock = samples.find(p => p.kind === "lock_slot")!;
		ctx.assert.eq(proposalToMutation(lock), null, "lock_slot proposal returns null mutation");

		// swap_ingredient with explicit mutation blob round-trips.
		const swap = samples.find(p => p.kind === "swap_ingredient")!;
		const swapMut = proposalToMutation(swap);
		ctx.assert.ok(!!swapMut, "swap_ingredient produces a mutation");
		ctx.assert.eq(swapMut?.kind, "swap_ingredient", "swap_ingredient mutation kind preserved");
		ctx.assert.eq((swapMut as { from_name?: string }).from_name, "fish sauce", "swap_ingredient mutation carries from_name");
		ctx.assert.eq((swapMut as { to_name?: string }).to_name, "soy sauce", "swap_ingredient mutation carries to_name");

		// move_meal without explicit mutation blob is translated from parameters.
		const move = samples.find(p => p.kind === "move_meal")!;
		const moveMut = proposalToMutation(move);
		ctx.assert.ok(!!moveMut, "move_meal proposal translates to a mutation");
		ctx.assert.eq(moveMut?.kind, "move_meal", "move_meal mutation kind correct");

		// cancel_meal translates from parameters.
		const cancel = samples.find(p => p.kind === "cancel_meal")!;
		const cancelMut = proposalToMutation(cancel);
		ctx.assert.ok(!!cancelMut, "cancel_meal proposal translates to a mutation");
		ctx.assert.eq(cancelMut?.kind, "cancel_meal", "cancel_meal mutation kind correct");

		// add_meal mutation carries the hint.
		const addMeal = samples.find(p => p.kind === "add_meal")!;
		const addMut = proposalToMutation(addMeal);
		ctx.assert.ok(!!addMut, "add_meal proposal translates to a mutation");
		ctx.assert.eq((addMut as { hint?: string }).hint, "consume leftovers", "add_meal mutation carries hint");

		// split_batch with explicit mutation blob preserves at_date.
		const split = samples.find(p => p.kind === "split_batch")!;
		const splitMut = proposalToMutation(split);
		ctx.assert.eq(splitMut?.kind, "split_batch", "split_batch mutation kind correct");
		ctx.assert.eq((splitMut as { at_date?: string }).at_date, "2026-05-15", "split_batch mutation carries at_date from explicit mutation blob");

		// move_shop without an explicit mutation blob translates from parameters.
		const moveShop = samples.find(p => p.kind === "move_shop")!;
		const moveShopMut = proposalToMutation(moveShop);
		ctx.assert.ok(!!moveShopMut, "move_shop proposal translates to a mutation");
		ctx.assert.eq((moveShopMut as { new_date?: string }).new_date, "2026-05-15", "move_shop mutation carries new_date");

		// add_shop translates and carries items.
		const addShop = samples.find(p => p.kind === "add_shop")!;
		const addShopMut = proposalToMutation(addShop);
		ctx.assert.ok(!!addShopMut, "add_shop proposal translates to a mutation");
		ctx.assert.eq((addShopMut as { date?: string }).date, "2026-05-15", "add_shop mutation carries date");

		// drop_item_from_shop translates.
		const drop = samples.find(p => p.kind === "drop_item_from_shop")!;
		const dropMut = proposalToMutation(drop);
		ctx.assert.ok(!!dropMut, "drop_item_from_shop proposal translates to a mutation");
		ctx.assert.eq((dropMut as { item_name?: string }).item_name, "spinach", "drop_item_from_shop mutation carries item_name");

		// merge_batches translates.
		const merge = samples.find(p => p.kind === "merge_batches")!;
		const mergeMut = proposalToMutation(merge);
		ctx.assert.ok(!!mergeMut, "merge_batches proposal translates to a mutation");
		ctx.assert.eq(mergeMut?.kind, "merge_batches", "merge_batches mutation kind correct");

		// slide_prep_date translates.
		const slide = samples.find(p => p.kind === "slide_prep_date")!;
		const slideMut = proposalToMutation(slide);
		ctx.assert.ok(!!slideMut, "slide_prep_date proposal translates to a mutation");
		ctx.assert.eq((slideMut as { new_prep_date?: string }).new_prep_date, "2026-05-12", "slide_prep_date mutation carries new_prep_date");

		// substitute_recipe translates.
		const sub = samples.find(p => p.kind === "substitute_recipe")!;
		const subMut = proposalToMutation(sub);
		ctx.assert.ok(!!subMut, "substitute_recipe proposal translates to a mutation");

		// replace_meal translates.
		const replace = samples.find(p => p.kind === "replace_meal")!;
		const replaceMut = proposalToMutation(replace);
		ctx.assert.ok(!!replaceMut, "replace_meal proposal translates to a mutation");
		ctx.assert.eq(replaceMut?.kind, "replace_meal", "replace_meal mutation kind correct");

		// --- plantSubstitutionFor --------------------------------------------------
		// Sanity: the dietary-critic substitution table covers the headline cases.
		ctx.assert.ok(!!plantSubstitutionFor("fish sauce"), "fish sauce has a plant substitution");
		ctx.assert.ok(!!plantSubstitutionFor("salmon"), "salmon has a plant substitution");
		ctx.assert.ok(!!plantSubstitutionFor("seared salmon fillet"), "substring matching works for salmon");
		ctx.assert.eq(plantSubstitutionFor("cosmic ray"), null, "unknown ingredient returns null");
	},
};

export default u09;
