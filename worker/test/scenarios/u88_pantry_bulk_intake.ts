// U88 — Pantry bulk intake (Phase B): text path + photo-mode error envelope.
//
// Confirms:
//   * mode='text' parses newline + comma separated lists, dedupes,
//     auto-categorizes, and writes mise_kitchen_inventory rows.
//   * Trait deltas fire: a 30+ item list moves pantry_first_vs_shop_fresh
//     toward 0.0 (pantry-first); a tiny 5-item list moves it toward 1.0
//     (shop-fresh).
//   * A synthetic mise_onboarding_responses row is appended with
//     question_kind="_pantry_bulk_intake".
//   * mode='photo' without bridge wired returns ok=false with a clear
//     vision_unavailable error, instead of throwing.
//   * replace_existing soft-deletes the prior un-consumed inventory.

import type { Scenario } from "../lib/types";
import { createMockD1 } from "../lib/mock-d1";
import { migrateHouseholdMemorySchema } from "../../src/mise-graph/admin-household-memory";
import { migrateOnboardingSchema } from "../../src/mise-graph/schemas/migrations";
import { migrateEquipmentSchema } from "../../src/mise-graph/equipment";
import { setPantryBulk, parseFreeTextItems, categorizeName } from "../../src/mise-graph/onboarding-bulk";
import { listInventory } from "../../src/mise-graph/kitchen-inventory";
import { listTraits, listResponses } from "../../src/mise-graph/onboarding";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

const u88: Scenario = {
	id: "u88",
	name: "Phase B pantry bulk intake: text + photo-stub + traits",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const db = createMockD1();
		const env = { DB: db as unknown as D1Database } as MiseGraphEnv;
		await migrateHouseholdMemorySchema(env);
		await migrateOnboardingSchema(env);
		await migrateEquipmentSchema(env);

		// 1. parseFreeTextItems handles newlines, commas, bullets, parentheticals.
		const rawText = `- chickpeas
* olive oil (cold-pressed)
1. cumin
- harissa
yogurt, feta, mint
chickpeas`; // duplicate at the end, must be deduped.
		const parsed = parseFreeTextItems(rawText);
		ctx.assert.contains(parsed, "chickpeas", "parser captures chickpeas");
		ctx.assert.contains(parsed, "olive oil", "parser strips trailing parenthetical");
		ctx.assert.contains(parsed, "yogurt", "parser splits on commas");
		ctx.assert.contains(parsed, "feta", "parser splits on commas (mid-line)");
		ctx.assert.contains(parsed, "mint", "parser splits on commas (last)");
		ctx.assert.eq(parsed.filter(p => p === "chickpeas").length, 1, "duplicates deduped case-insensitively");

		// 2. categorizeName routes common items.
		ctx.assert.eq(categorizeName("chickpeas"), "protein", "chickpeas → protein");
		ctx.assert.eq(categorizeName("yogurt"), "dairy", "yogurt → dairy");
		ctx.assert.eq(categorizeName("rice"), "grains", "rice → grains");
		ctx.assert.eq(categorizeName("olive oil"), "pantry", "olive oil → pantry");
		ctx.assert.eq(categorizeName("kale"), "produce", "kale → produce");
		ctx.assert.eq(categorizeName("strawberries"), "fruit", "strawberries → fruit");

		// 3. Pantry-rich path (>=30 items) fires pantry-first delta toward 0.0.
		const richList = [
			"chickpeas", "lentils", "tofu", "olive oil", "tahini", "rice", "pasta",
			"oats", "quinoa", "farro", "yogurt", "feta", "parmesan", "milk",
			"butter", "kale", "spinach", "tomatoes", "onions", "garlic", "ginger",
			"lemons", "limes", "harissa", "miso", "soy sauce", "sesame oil",
			"cumin", "paprika", "cardamom", "honey", "maple syrup", "almonds",
			"cashews", "peanuts",
		];
		const richResult = await setPantryBulk(env, {
			household_id: "hh_u88_rich",
			mode: "text",
			text: richList.join("\n"),
		});
		ctx.assert.eq(richResult.ok, true, "rich pantry write succeeded");
		ctx.assert.gte(richResult.items_recorded, 30, "rich pantry recorded ≥30 items");
		ctx.assert.contains(richResult.trait_deltas, "pantry_first_vs_shop_fresh", "trait delta fired for pantry-first");
		ctx.assert.gt(richResult.categories.length, 1, "categorized into multiple buckets");

		const richTraits = await listTraits(env, "hh_u88_rich");
		const pantryTrait = richTraits.find(t => t.trait_name === "pantry_first_vs_shop_fresh");
		ctx.assert.ok(!!pantryTrait, "pantry_first_vs_shop_fresh trait persisted");
		ctx.assert.lte(pantryTrait!.trait_value, 0.5, "rich pantry moves trait toward 0.0 (pantry-first end)");
		ctx.assert.gt(pantryTrait!.confidence, 0, "trait confidence rose from 0");

		// 4. The synthetic response row exists.
		const responses = await listResponses(env, "hh_u88_rich");
		const bulkRow = responses.find(r => r.question_kind === "_pantry_bulk_intake");
		ctx.assert.ok(!!bulkRow, "synthetic _pantry_bulk_intake response logged");
		ctx.assert.eq(bulkRow!.tier, 1, "bulk-intake tagged as tier 1");
		ctx.assert.ok(!!bulkRow!.inferred_traits_json, "inferred_traits_json captured on the response row");

		// 5. Items landed in mise_kitchen_inventory.
		const inv = await listInventory(env, "hh_u88_rich");
		ctx.assert.gte(inv.length, 30, "kitchen inventory has the bulk items");
		const sourcedFromBulk = inv.filter(i => i.source === "bulk_intake");
		ctx.assert.gte(sourcedFromBulk.length, 30, "all rich items tagged source=bulk_intake");

		// 6. Bare pantry path (<=8 items) fires shop-fresh delta toward 1.0.
		const bareResult = await setPantryBulk(env, {
			household_id: "hh_u88_bare",
			mode: "text",
			text: "olive oil\nsalt\npepper\ngarlic\nlemons",
		});
		ctx.assert.eq(bareResult.ok, true, "bare pantry write succeeded");
		ctx.assert.eq(bareResult.items_recorded, 5, "bare pantry has 5 items");
		ctx.assert.contains(bareResult.trait_deltas, "pantry_first_vs_shop_fresh", "shop-fresh delta fired");

		const bareTraits = await listTraits(env, "hh_u88_bare");
		const bareTrait = bareTraits.find(t => t.trait_name === "pantry_first_vs_shop_fresh");
		ctx.assert.ok(!!bareTrait, "trait persisted for bare pantry");
		ctx.assert.gte(bareTrait!.trait_value, 0.5, "bare pantry moves trait toward 1.0 (shop-fresh end)");

		// 7. Mid-size pantry (between thresholds) fires NO trait delta.
		const midResult = await setPantryBulk(env, {
			household_id: "hh_u88_mid",
			mode: "text",
			text: "rice\noats\nquinoa\ntomatoes\nonions\ngarlic\nyogurt\nbutter\nfeta\nparsley\nlemons\nolive oil\ntahini\nharissa\nmiso",
		});
		ctx.assert.eq(midResult.ok, true, "mid pantry write succeeded");
		ctx.assert.eq(midResult.trait_deltas.length, 0, "mid-size pantry fires no trait delta (between thresholds)");

		// 8. Photo mode without bridge bindings returns ok=false with a clear error.
		const photoResult = await setPantryBulk(env, {
			household_id: "hh_u88_photo",
			mode: "photo",
			image_b64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
		});
		ctx.assert.eq(photoResult.ok, false, "photo mode without MESH binding fails cleanly");
		ctx.assert.ok(typeof photoResult.error === "string" && photoResult.error.includes("vision_unavailable"), "error envelope mentions vision_unavailable");
		ctx.assert.eq(photoResult.items_recorded, 0, "no items recorded when vision is unavailable");

		// 9. replace_existing soft-deletes the prior un-consumed inventory.
		const before = await listInventory(env, "hh_u88_rich");
		const beforeCount = before.length;
		ctx.assert.gt(beforeCount, 0, "before: rich pantry has items");
		const replaced = await setPantryBulk(env, {
			household_id: "hh_u88_rich",
			mode: "text",
			text: "rice\noats\nbeans",
			replace_existing: true,
		});
		ctx.assert.eq(replaced.ok, true, "replace_existing write succeeded");
		const after = await listInventory(env, "hh_u88_rich");
		ctx.assert.lte(after.length, 5, "after replace_existing only the new items show in non-consumed list");

		ctx.notes.push(`u88 rich pantry trait value=${pantryTrait!.trait_value} conf=${pantryTrait!.confidence}`);
		ctx.notes.push(`u88 bare pantry trait value=${bareTrait!.trait_value} conf=${bareTrait!.confidence}`);
		ctx.notes.push(`u88 categories from rich list: ${richResult.categories.join(",")}`);
	},
};

export default u88;
