// U90 — Traditions bulk set (Phase B): cadence validation, replace semantics.
//
// Confirms:
//   * Each tradition with a valid cadence lands in mise_household_traditions.
//   * Cadence formats accepted: weekly:<day>, monthly:<1st-saturday>,
//     seasonal:<season>, annual:<event>.
//   * Invalid cadences (e.g. "every now and then") are rejected with a clear
//     reason and never inserted.
//   * Same (household_id, name) replaces the existing row instead of creating
//     a duplicate.
//   * must_include_ingredients are stored as JSON.

import type { Scenario } from "../lib/types";
import { createMockD1 } from "../lib/mock-d1";
import { migrateHouseholdMemorySchema } from "../../src/mise-graph/admin-household-memory";
import { migrateOnboardingSchema } from "../../src/mise-graph/schemas/migrations";
import { setTraditions } from "../../src/mise-graph/onboarding-bulk";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

interface TraditionRow {
	tradition_id: string;
	household_id: string;
	name: string;
	cadence: string;
	description: string | null;
	must_include_ingredients_json: string | null;
	must_include_format: string | null;
	origin_note: string | null;
	active: number;
	created_at_ms: number;
}

const u90: Scenario = {
	id: "u90",
	name: "Phase B traditions set: cadence validation + replace semantics",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const db = createMockD1();
		const env = { DB: db as unknown as D1Database } as MiseGraphEnv;
		await migrateHouseholdMemorySchema(env);
		await migrateOnboardingSchema(env);

		// 1. Happy path: 4 valid cadences across the 4 supported kinds.
		const r1 = await setTraditions(env, {
			household_id: "hh_u90",
			traditions: [
				{ name: "Friday Pizza Night", cadence: "weekly:friday", description: "homemade pizza, kids in charge of toppings", origin_note: "started 2023", must_include_format: "pizza", must_include_ingredients: ["mozzarella", "tomato"] },
				{ name: "First-Saturday Brunch", cadence: "monthly:1st-saturday" },
				{ name: "Fall Squash Soup", cadence: "seasonal:fall" },
				{ name: "Thanksgiving", cadence: "annual:thanksgiving" },
			],
		});
		ctx.assert.eq(r1.ok, true, "all four valid cadences accepted");
		ctx.assert.eq(r1.traditions_set, 4, "4 traditions inserted");
		ctx.assert.eq(r1.rejected.length, 0, "no rejections");

		const all1 = await env.DB.prepare(
			`SELECT tradition_id, household_id, name, cadence, description,
				must_include_ingredients_json, must_include_format, origin_note,
				active, created_at_ms
			 FROM mise_household_traditions
			 WHERE household_id = ?`,
		).bind("hh_u90").all<TraditionRow>();
		ctx.assert.eq((all1.results || []).length, 4, "4 rows persisted");

		const pizza = (all1.results || []).find(r => r.name === "Friday Pizza Night");
		ctx.assert.ok(!!pizza, "pizza row persisted");
		ctx.assert.eq(pizza!.cadence, "weekly:friday", "cadence stored lowercased");
		ctx.assert.eq(pizza!.active, 1, "active=1 by default");
		ctx.assert.ok(!!pizza!.must_include_ingredients_json, "ingredients JSON serialized");
		const ings = JSON.parse(pizza!.must_include_ingredients_json!) as string[];
		ctx.assert.contains(ings, "mozzarella", "ingredient JSON round-trips");
		ctx.assert.contains(ings, "tomato", "ingredient JSON round-trips (second item)");

		// 2. Invalid cadences are rejected, not inserted.
		const r2 = await setTraditions(env, {
			household_id: "hh_u90",
			traditions: [
				{ name: "Whenever Time", cadence: "every now and then" },
				{ name: "Bad Day", cadence: "weekly:funday" },                 // funday is not a real day
				{ name: "Bad Week-Of-Month", cadence: "monthly:5th-monday" },  // 5th not allowed
				{ name: "Bad Season", cadence: "seasonal:apocalypse" },        // not a real season
				{ name: "Empty Cadence", cadence: "" },
				{ name: "", cadence: "weekly:friday" },                        // empty name
			],
		});
		ctx.assert.eq(r2.ok, false, "invalid cadences flip ok=false");
		ctx.assert.eq(r2.traditions_set, 0, "no invalid rows inserted");
		ctx.assert.gte(r2.rejected.length, 5, "rejection list has all bad inputs");
		const reasons = r2.rejected.map(r => r.reason).join(" | ");
		ctx.assert.ok(reasons.length > 0, "every rejection has a reason");

		// Sanity: the invalid run did not pollute the table.
		const after2 = await env.DB.prepare(
			`SELECT name FROM mise_household_traditions WHERE household_id = ?`,
		).bind("hh_u90").all<{ name: string }>();
		ctx.assert.eq((after2.results || []).length, 4, "still 4 rows after rejected run (no inserts on bad input)");

		// 3. Replace semantics: re-set Friday Pizza Night with new origin.
		const r3 = await setTraditions(env, {
			household_id: "hh_u90",
			traditions: [
				{ name: "Friday Pizza Night", cadence: "weekly:friday", origin_note: "updated 2026" },
			],
		});
		ctx.assert.eq(r3.ok, true, "replace ok");
		ctx.assert.eq(r3.traditions_set, 1, "1 tradition replaced");

		const after3 = await env.DB.prepare(
			`SELECT tradition_id, name, origin_note FROM mise_household_traditions
			 WHERE household_id = ? AND name = ?`,
		).bind("hh_u90", "Friday Pizza Night").all<{ tradition_id: string; name: string; origin_note: string | null }>();
		ctx.assert.eq((after3.results || []).length, 1, "still exactly one row for the same name (no duplicate)");
		ctx.assert.eq((after3.results || [])[0].origin_note, "updated 2026", "origin_note overwritten on replace");
		ctx.assert.eq((after3.results || [])[0].tradition_id, pizza!.tradition_id, "tradition_id is preserved across replace (same row updated)");

		// 4. Mixed valid/invalid in one call: valid ones are inserted, invalid rejected.
		const r4 = await setTraditions(env, {
			household_id: "hh_u90b",
			traditions: [
				{ name: "Valid", cadence: "weekly:saturday" },
				{ name: "Invalid", cadence: "lunar:wednesday" },
			],
		});
		ctx.assert.eq(r4.ok, false, "mixed run flips ok=false (one rejected)");
		ctx.assert.eq(r4.traditions_set, 1, "valid one still inserted");
		ctx.assert.eq(r4.rejected.length, 1, "invalid one rejected");
		ctx.assert.eq(r4.rejected[0].name, "Invalid", "rejection names the bad tradition");

		ctx.notes.push(`u90 final traditions for hh_u90: ${(after2.results || []).length}`);
	},
};

export default u90;
