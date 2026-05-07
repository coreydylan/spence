// U5 — Shelf-life table sanity checks.
//
// Verifies the lookup table returns sensible values for known items,
// pantry-stable items get long shelf lives, and unknown items still
// resolve to a reasonable non-zero default.

import type { Scenario } from "../lib/types";
import { lookupShelfLife, defaultShelfLife } from "../../src/mise-graph/shelf-life-table";

const u05: Scenario = {
	id: "u05",
	name: "Shelf-life table returns sane values for known + unknown items",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// Shiitake — perishable tier, ~96h fridge.
		const shiitake = lookupShelfLife("shiitake");
		ctx.notes.push(`shiitake: ${shiitake.shelf_life_fridge_hours}h ${shiitake.category}`);
		ctx.assert.gte(shiitake.shelf_life_fridge_hours, 72, "shiitake fridge ≥ 72h");
		ctx.assert.lte(shiitake.shelf_life_fridge_hours, 120, "shiitake fridge ≤ 120h");
		ctx.assert.eq(shiitake.category, "perishable", "shiitake is perishable");

		// Rice — pantry stable, ≥180 days.
		const rice = lookupShelfLife("rice");
		ctx.notes.push(`rice: ${rice.shelf_life_fridge_hours}h ${rice.category}`);
		ctx.assert.eq(rice.category, "pantry_stable", "rice is pantry_stable");
		ctx.assert.gte(rice.shelf_life_fridge_hours, 4320, "rice fridge ≥ 180 days (4320h)");

		// Arugula — ultra-perishable, ~72h.
		const arugula = lookupShelfLife("arugula");
		ctx.notes.push(`arugula: ${arugula.shelf_life_fridge_hours}h ${arugula.category}`);
		ctx.assert.eq(arugula.category, "ultra_perishable", "arugula is ultra_perishable");
		ctx.assert.lte(arugula.shelf_life_fridge_hours, 96, "arugula ≤ 96h");

		// Case-insensitive
		const arugulaUpper = lookupShelfLife("Arugula");
		ctx.assert.eq(arugulaUpper.shelf_life_fridge_hours, arugula.shelf_life_fridge_hours, "lookup is case-insensitive");

		// Fuzzy fallback — "fresh basil" should resolve to "basil".
		const freshBasil = lookupShelfLife("fresh basil");
		ctx.assert.eq(freshBasil.category, "ultra_perishable", "fresh basil resolves to ultra_perishable");

		// Unknown item — defaultShelfLife produces non-zero hours.
		const unknown = defaultShelfLife("xyz_unknown");
		ctx.notes.push(`unknown: ${unknown.shelf_life_fridge_hours}h ${unknown.category}`);
		ctx.assert.gt(unknown.shelf_life_fridge_hours, 0, "unknown item has non-zero shelf life");
		ctx.assert.gte(unknown.shelf_life_fridge_hours, 72, "unknown defaults at least to 72h");

		// Lookup with totally unknown name still returns something.
		const wild = lookupShelfLife("synthetic_test_item_42");
		ctx.assert.gt(wild.shelf_life_fridge_hours, 0, "lookupShelfLife always returns >0 hours");
	},
};

export default u05;
