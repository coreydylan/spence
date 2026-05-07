// U23 — Household model: profile CRUD, cooked-meal logging, anchor evolution.
//
// Boots the in-memory D1 shim, runs the household-memory migration, and
// exercises upsert / read / record / compute paths.

import type { Scenario } from "../lib/types";
import { createMockD1 } from "../lib/mock-d1";
import { migrateHouseholdMemorySchema } from "../../src/mise-graph/admin-household-memory";
import {
	getHouseholdProfile,
	upsertHouseholdProfile,
	listHouseholds,
	recordCookedMeal,
	computeAnchorEvolution,
	updateCuisinePreferences,
} from "../../src/mise-graph/household-model";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

const u23: Scenario = {
	id: "u23",
	name: "Household model: profile CRUD + meal history + anchor evolution",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const db = createMockD1();
		const env = { DB: db as unknown as D1Database } as MiseGraphEnv;
		const migration = await migrateHouseholdMemorySchema(env);
		ctx.assert.contains(migration.migrated, "mise_household_profiles", "migration creates household profile table");
		ctx.assert.contains(migration.migrated, "mise_meal_history", "migration creates meal history table");
		ctx.assert.contains(migration.migrated, "mise_anchor_evolution", "migration creates anchor evolution table");

		// 1. Empty get returns null.
		const missing = await getHouseholdProfile(env, "hh_a");
		ctx.assert.eq(missing, null, "missing profile returns null");

		// 2. Upsert + round-trip.
		const created = await upsertHouseholdProfile(env, {
			household_id: "hh_a",
			display_name: "Alice & Bob",
			people_count: 3,
			dietary: ["vegetarian"],
			equipment: ["dutch_oven", "stand_mixer"],
			current_anchors: ["chickpeas", "tahini"],
			cuisine_preferences: { mediterranean: 0.8 },
			default_pantry: ["olive_oil", "lemon"],
			notes: "loves bowls",
		});
		ctx.assert.eq(created.household_id, "hh_a", "create returns household_id");
		ctx.assert.eq(created.people_count, 3, "people_count persisted");
		ctx.assert.eq(created.dietary[0], "vegetarian", "dietary persisted");

		const fetched = await getHouseholdProfile(env, "hh_a");
		ctx.assert.ok(!!fetched, "profile fetched back");
		ctx.assert.eq(fetched!.display_name, "Alice & Bob", "display_name round-trips");
		ctx.assert.eq(fetched!.equipment.length, 2, "equipment array round-trips");
		ctx.assert.eq(fetched!.current_anchors.length, 2, "current_anchors round-trips");
		ctx.assert.eq(fetched!.cuisine_preferences["mediterranean"], 0.8, "cuisine_preferences round-trips");

		// 3. Partial upsert merges with existing values.
		const updated = await upsertHouseholdProfile(env, {
			household_id: "hh_a",
			notes: "updated notes",
		});
		ctx.assert.eq(updated.notes, "updated notes", "partial upsert overwrites notes");
		ctx.assert.eq(updated.people_count, 3, "partial upsert preserves people_count");
		ctx.assert.eq(updated.equipment.length, 2, "partial upsert preserves equipment");

		// 4. listHouseholds picks it up.
		await upsertHouseholdProfile(env, { household_id: "hh_b", display_name: "Cleo" });
		const all = await listHouseholds(env);
		ctx.assert.eq(all.length, 2, "listHouseholds returns both profiles");

		// 5. recordCookedMeal updates anchor evolution.
		// Cook 6 meals all featuring chickpeas in the last 14 days.
		const today = new Date();
		const recentDates = [];
		for (let i = 0; i < 6; i++) {
			const d = new Date(today);
			d.setUTCDate(d.getUTCDate() - i * 2);  // 0, 2, 4, 6, 8, 10 days ago
			recentDates.push(d.toISOString().slice(0, 10));
		}
		for (let i = 0; i < recentDates.length; i++) {
			await recordCookedMeal(env, "hh_a", {
				date: recentDates[i],
				slot: "dinner",
				title: `chickpea bowl ${i}`,
				cuisine: ["mediterranean"],
				format: "bowl",
				anchors_used: ["chickpeas", "tahini"],
			});
		}
		// Add a couple older meals (>14 days ago) without chickpeas.
		const olderDate = new Date(today);
		olderDate.setUTCDate(olderDate.getUTCDate() - 20);
		await recordCookedMeal(env, "hh_a", {
			date: olderDate.toISOString().slice(0, 10),
			slot: "dinner",
			title: "tofu noodles",
			cuisine: ["japanese"],
			format: "noodles",
			anchors_used: ["tofu"],
		});

		const evolution = await computeAnchorEvolution(env, "hh_a");
		ctx.assert.gt(evolution.length, 0, "anchor evolution returns entries");
		const chickpeas = evolution.find(e => e.canonical_name === "chickpeas");
		ctx.assert.ok(!!chickpeas, "chickpeas appear in evolution");
		ctx.assert.gte(chickpeas!.recent_count_28d, 6, "chickpeas counted across 6 cooked meals");
		ctx.assert.contains(["rising", "saturated", "stable"], chickpeas!.trend, "chickpeas trend is rising/saturated/stable");

		const tofu = evolution.find(e => e.canonical_name === "tofu");
		ctx.assert.ok(!!tofu, "tofu also appears");
		// tofu was older — should not be rising; stable or falling
		ctx.assert.contains(["stable", "falling"], tofu!.trend, "tofu trend is stable or falling");

		// 6. updateCuisinePreferences computes a normalized weight map.
		const cuisines = await updateCuisinePreferences(env, "hh_a");
		ctx.assert.ok(typeof cuisines["mediterranean"] === "number", "mediterranean cuisine has weight");
		ctx.assert.eq(cuisines["mediterranean"], 1, "heaviest cuisine normalizes to 1.0");
		ctx.assert.gt(cuisines["mediterranean"], cuisines["japanese"] ?? 0, "mediterranean weighted higher than japanese");

		// 7. Verify the household profile has been updated with new cuisine prefs.
		const finalProfile = await getHouseholdProfile(env, "hh_a");
		ctx.assert.eq(finalProfile!.cuisine_preferences["mediterranean"], 1, "profile picked up updated cuisine preferences");

		ctx.notes.push(`u23 anchor entries: ${evolution.length}; chickpeas trend = ${chickpeas!.trend}`);
	},
};

export default u23;
