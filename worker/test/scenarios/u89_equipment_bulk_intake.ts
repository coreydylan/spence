// U89 — Equipment bulk intake (Phase B): rich vs minimalist trait deltas.
//
// Confirms:
//   * Each slug runs through ensureEquipmentDefined; new slugs land in
//     mise_equipment_definitions with sensible defaults; already-defined
//     slugs are reported in already_defined.
//   * >=15 slugs → equipment_rich_vs_minimalist toward 0.0 (rich).
//   * <=4 slugs → equipment_rich_vs_minimalist toward 1.0 (minimalist).
//   * A synthetic _equipment_bulk_intake response row is appended.
//   * Re-running the same slug list does not double-count or fire a
//     second delta of the same magnitude (idempotent on equipment table).

import type { Scenario } from "../lib/types";
import { createMockD1 } from "../lib/mock-d1";
import { migrateHouseholdMemorySchema } from "../../src/mise-graph/admin-household-memory";
import { migrateOnboardingSchema } from "../../src/mise-graph/schemas/migrations";
import { migrateEquipmentSchema, listEquipment } from "../../src/mise-graph/equipment";
import { setEquipmentBulk } from "../../src/mise-graph/onboarding-bulk";
import { listTraits, listResponses } from "../../src/mise-graph/onboarding";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

const u89: Scenario = {
	id: "u89",
	name: "Phase B equipment bulk intake: rich vs minimalist deltas + idempotency",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const db = createMockD1();
		const env = { DB: db as unknown as D1Database } as MiseGraphEnv;
		await migrateHouseholdMemorySchema(env);
		await migrateOnboardingSchema(env);
		await migrateEquipmentSchema(env);

		// 1. Rich kitchen: >=15 slugs.
		const richSlugs = [
			"oven", "stovetop", "instant_pot", "grill", "smoker", "skillet",
			"saucepan", "fryer", "blender", "food_processor", "stand_mixer",
			"chefs_knife", "cutting_board", "counter", "sink_basin",
			"dutch_oven", "wok", "rice_cooker",
		];
		const rich = await setEquipmentBulk(env, {
			household_id: "hh_u89_rich",
			equipment_slugs: richSlugs,
		});
		ctx.assert.eq(rich.ok, true, "rich equipment intake ok");
		ctx.assert.eq(rich.defined_count, richSlugs.length, "all slugs defined");
		ctx.assert.eq(rich.newly_defined.length, richSlugs.length, "first call: every slug is newly defined");
		ctx.assert.eq(rich.already_defined.length, 0, "first call: no slugs already-defined");
		ctx.assert.contains(rich.trait_deltas, "equipment_rich_vs_minimalist", "rich delta fired");

		const richTraits = await listTraits(env, "hh_u89_rich");
		const richTrait = richTraits.find(t => t.trait_name === "equipment_rich_vs_minimalist");
		ctx.assert.ok(!!richTrait, "trait persisted for rich kitchen");
		ctx.assert.lte(richTrait!.trait_value, 0.5, "rich kitchen moves trait toward 0.0 (equipment-rich end)");
		ctx.assert.gt(richTrait!.confidence, 0, "trait confidence rose");

		// 2. Equipment definitions actually exist now.
		const defs = await listEquipment(env, "hh_u89_rich");
		ctx.assert.gte(defs.length, richSlugs.length, "equipment definitions persisted");

		// 3. Synthetic response logged.
		const responses = await listResponses(env, "hh_u89_rich");
		const bulkRow = responses.find(r => r.question_kind === "_equipment_bulk_intake");
		ctx.assert.ok(!!bulkRow, "_equipment_bulk_intake response logged");

		// 4. Re-run with the same slugs: defs already exist, no new ones.
		const second = await setEquipmentBulk(env, {
			household_id: "hh_u89_rich",
			equipment_slugs: richSlugs,
		});
		ctx.assert.eq(second.newly_defined.length, 0, "second call: no new defs");
		ctx.assert.eq(second.already_defined.length, richSlugs.length, "second call: every slug already defined");

		// 5. Minimalist kitchen: <=4 slugs.
		const minSlugs = ["chefs_knife", "skillet", "saucepan"];
		const minimalist = await setEquipmentBulk(env, {
			household_id: "hh_u89_min",
			equipment_slugs: minSlugs,
		});
		ctx.assert.eq(minimalist.ok, true, "minimalist intake ok");
		ctx.assert.contains(minimalist.trait_deltas, "equipment_rich_vs_minimalist", "minimalist delta fired");
		const minTraits = await listTraits(env, "hh_u89_min");
		const minTrait = minTraits.find(t => t.trait_name === "equipment_rich_vs_minimalist");
		ctx.assert.ok(!!minTrait, "minimalist trait persisted");
		ctx.assert.gte(minTrait!.trait_value, 0.5, "minimalist moves trait toward 1.0");

		// 6. Mid-size kitchen: between thresholds → no delta.
		const mid = await setEquipmentBulk(env, {
			household_id: "hh_u89_mid",
			equipment_slugs: ["oven", "stovetop", "skillet", "saucepan", "blender", "chefs_knife", "cutting_board"],
		});
		ctx.assert.eq(mid.ok, true, "mid kitchen ok");
		ctx.assert.eq(mid.trait_deltas.length, 0, "mid-size kitchen fires no trait delta");

		// 7. Duplicate / empty slugs are deduped + ignored.
		const dedup = await setEquipmentBulk(env, {
			household_id: "hh_u89_dedup",
			equipment_slugs: ["oven", " oven", "OVEN", "", "  ", "skillet"],
		});
		ctx.assert.eq(dedup.ok, true, "dedup intake ok");
		ctx.assert.eq(dedup.defined_count, 2, "dedup yields 2 unique slugs (oven + skillet)");

		ctx.notes.push(`u89 rich kitchen trait value=${richTrait!.trait_value} conf=${richTrait!.confidence}`);
		ctx.notes.push(`u89 minimalist trait value=${minTrait!.trait_value} conf=${minTrait!.confidence}`);
	},
};

export default u89;
