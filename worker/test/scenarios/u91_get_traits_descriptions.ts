// U91 — household_get_traits read-only API + description rendering.
//
// Confirms:
//   * getTraits returns all 7 dimensions, even ones never observed (defaults
//     to value=0.5, confidence=0).
//   * with_descriptions=true adds a human-readable summary per row.
//   * Low confidence (<0.3) prefixes with "preliminary signal:".
//   * Once a delta lifts confidence above 0.3 the prefix drops.
//   * Descriptions follow the threshold rules: <=0.3 → low summary,
//     0.3..0.7 → mid, >=0.7 → high.

import type { Scenario } from "../lib/types";
import { createMockD1 } from "../lib/mock-d1";
import { migrateHouseholdMemorySchema } from "../../src/mise-graph/admin-household-memory";
import { migrateOnboardingSchema } from "../../src/mise-graph/schemas/migrations";
import { migrateEquipmentSchema } from "../../src/mise-graph/equipment";
import { describeTrait, getTraits } from "../../src/mise-graph/onboarding-traits";
import { setEquipmentBulk, setPantryBulk } from "../../src/mise-graph/onboarding-bulk";
import { TRAIT_NAMES } from "../../src/mise-graph/onboarding-questions";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

const u91: Scenario = {
	id: "u91",
	name: "Phase B household_get_traits: defaults, descriptions, threshold rendering",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const db = createMockD1();
		const env = { DB: db as unknown as D1Database } as MiseGraphEnv;
		await migrateHouseholdMemorySchema(env);
		await migrateOnboardingSchema(env);
		await migrateEquipmentSchema(env);

		// 1. Brand-new household: all 7 dimensions present at defaults.
		const empty = await getTraits(env, { household_id: "hh_u91_empty" });
		ctx.assert.eq(empty.traits.length, 7, "always returns all 7 dimensions");
		const names = new Set(empty.traits.map(t => t.trait_name));
		for (const expected of TRAIT_NAMES) {
			ctx.assert.eq(names.has(expected), true, `dimension ${expected} present in default response`);
		}
		for (const t of empty.traits) {
			ctx.assert.eq(t.value, 0.5, `${t.trait_name} default value=0.5`);
			ctx.assert.eq(t.confidence, 0, `${t.trait_name} default confidence=0`);
			ctx.assert.eq(t.evidence_count, 0, `${t.trait_name} default evidence_count=0`);
			ctx.assert.eq(typeof t.description, "undefined", `${t.trait_name} no description without flag`);
		}

		// 2. With descriptions: every row has a non-empty description string.
		const emptyWithDesc = await getTraits(env, { household_id: "hh_u91_empty", with_descriptions: true });
		for (const t of emptyWithDesc.traits) {
			ctx.assert.ok(typeof t.description === "string" && t.description.length > 0, `${t.trait_name} has description text`);
			ctx.assert.contains(t.description!, "preliminary signal", `${t.trait_name} default (conf=0) is flagged as preliminary signal`);
		}

		// 3. describeTrait threshold rendering — low / mid / high.
		ctx.assert.contains(describeTrait("ritual_vs_refueling", 0.1, 0.5), "ritual", "value 0.1 → low_summary mentions ritual");
		ctx.assert.contains(describeTrait("ritual_vs_refueling", 0.5, 0.5), "balanced", "value 0.5 → mid_summary mentions balanced");
		ctx.assert.contains(describeTrait("ritual_vs_refueling", 0.85, 0.5), "refueling", "value 0.85 → high_summary mentions refueling");

		// Low confidence prefix appears below 0.3.
		ctx.assert.contains(describeTrait("ritual_vs_refueling", 0.85, 0.1), "preliminary signal", "low confidence renders preliminary signal");
		// Above 0.3 the prefix drops.
		const highConf = describeTrait("ritual_vs_refueling", 0.85, 0.5);
		ctx.assert.eq(highConf.startsWith("preliminary signal"), false, "above 0.3 confidence: no preliminary prefix");

		// 4. Apply real evidence and re-read.
		// Pantry-rich → pantry_first_vs_shop_fresh trait toward 0.0 with confidence ~0.28
		// (delta_confidence 0.4 × decay 0.7 = 0.28). That keeps it in "preliminary"
		// territory after one observation, which is the exact behavior we want
		// to surface to the user as low-confidence.
		const richList = Array.from({ length: 32 }, (_, i) => `item_${i}`).join("\n");
		await setPantryBulk(env, { household_id: "hh_u91_evid", mode: "text", text: richList });

		// Equipment minimalist also lands on a single dimension.
		await setEquipmentBulk(env, { household_id: "hh_u91_evid", equipment_slugs: ["chefs_knife", "skillet", "saucepan"] });

		const evid = await getTraits(env, { household_id: "hh_u91_evid", with_descriptions: true });
		const pantry = evid.traits.find(t => t.trait_name === "pantry_first_vs_shop_fresh");
		ctx.assert.ok(!!pantry, "pantry_first_vs_shop_fresh present after evidence");
		ctx.assert.lte(pantry!.value, 0.5, "rich pantry: trait value at low end");
		ctx.assert.gt(pantry!.confidence, 0, "rich pantry: confidence rose from 0");
		ctx.assert.eq(pantry!.evidence_count, 1, "evidence_count=1 after one bulk-intake");
		ctx.assert.ok(typeof pantry!.description === "string" && pantry!.description.length > 0, "pantry has description after evidence");

		const equip = evid.traits.find(t => t.trait_name === "equipment_rich_vs_minimalist");
		ctx.assert.ok(!!equip, "equipment_rich_vs_minimalist present after evidence");
		ctx.assert.gte(equip!.value, 0.5, "minimalist kitchen: trait value at high end");

		// 5. Untouched dimensions still come back at defaults.
		const ritual = evid.traits.find(t => t.trait_name === "ritual_vs_refueling");
		ctx.assert.ok(!!ritual, "ritual_vs_refueling still present");
		ctx.assert.eq(ritual!.value, 0.5, "untouched dimension keeps default value");
		ctx.assert.eq(ritual!.evidence_count, 0, "untouched dimension keeps evidence_count=0");

		ctx.notes.push(`u91 evidenced pantry trait: value=${pantry!.value} conf=${pantry!.confidence}`);
		ctx.notes.push(`u91 evidenced equip trait: value=${equip!.value} conf=${equip!.confidence}`);
	},
};

export default u91;
