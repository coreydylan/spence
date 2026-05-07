// U78 — Component bucketing: keyword-typed roles claim ingredients before
// the primary-role fallback scoops the remainder.
//
// Regression from the live walkthrough: a Thai green curry with
// {jasmine rice, tofu, coconut milk, ...} fed through plan_compose_meal
// landed with `starch` as a hollow placeholder because `main` (a primary
// role) ran first and grabbed ALL raw_ingredients via the
// PRIMARY_ROLES fallback before `starch`'s rice-keyword match got a turn.
//
// Fix: two passes in fillComponents. Pass 1 = keyword match only (every
// slot claims its specifically-typed ingredients). Pass 2 = primary-role
// fallback for any unmatched required slot.

import type { Scenario } from "../lib/types";
import { fillComponents } from "../../src/mise-graph/composer-postpass";

interface Lite {
	name: string;
	qty?: number;
	unit?: string;
	grams?: number;
}

function meal(format: string, ingredients: Lite[]) {
	return {
		date: "2026-05-10",
		slot: "dinner" as const,
		title: `test ${format}`,
		format,
		people: 2,
		cuisine: ["test"],
		formula_ids: [],
		raw_ingredients: ingredients,
		notes: [],
		method_summary: "",
		leftovers_to: [],
		lineage: [],
	};
}

const u78: Scenario = {
	id: "u78",
	name: "Component bucketing: keyword roles claim before primary-role fallback",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// ── Curry: starch + main both required. Rice MUST land in starch ───
		const curryMeal = meal("curry", [
			{ name: "firm tofu", qty: 400, unit: "g" },
			{ name: "thai green curry paste", qty: 3, unit: "tbsp" },
			{ name: "coconut milk", qty: 400, unit: "ml" },
			{ name: "thai basil", qty: 40, unit: "g" },
			{ name: "thai eggplant", qty: 200, unit: "g" },
			{ name: "bamboo shoot", qty: 150, unit: "g" },
			{ name: "jasmine rice", qty: 300, unit: "g" },
			{ name: "lime", qty: 1, unit: "whole" },
			{ name: "sugar", qty: 1, unit: "tsp" },
		]);
		const curryCount = fillComponents(curryMeal as any, []);
		const curryComps = (curryMeal as any).components as Array<{ role: string; required: boolean; source: any; }>;

		ctx.assert.gte(curryCount, 2, "curry produced ≥ 2 components");
		const starch = curryComps.find(c => c.role === "starch");
		const main = curryComps.find(c => c.role === "main");
		ctx.assert.ok(!!starch, "curry has a starch component");
		ctx.assert.ok(!!main, "curry has a main component");
		const starchRaws = (starch?.source?.raw_ingredients || []).map((r: any) => r.name);
		const mainRaws = (main?.source?.raw_ingredients || []).map((r: any) => r.name);
		ctx.assert.contains(starchRaws, "jasmine rice", "jasmine rice landed in starch slot, not main");
		ctx.assert.eq(starchRaws.length, 1, "starch claims only the rice (not the rest)");
		ctx.assert.ok(!mainRaws.includes("jasmine rice"), "main does NOT contain jasmine rice");
		ctx.assert.contains(mainRaws, "firm tofu", "main has tofu");
		ctx.assert.contains(mainRaws, "coconut milk", "main has coconut milk");
		ctx.notes.push(`curry components: ${curryComps.map(c => c.role).join(", ")}`);
		ctx.notes.push(`  starch raws: ${starchRaws.join(", ")}`);
		ctx.notes.push(`  main raws (${mainRaws.length}): ${mainRaws.join(", ")}`);

		// ── Donburi: starch (rice) + main + optional sauce/garnish. Same fix ─
		const donburiMeal = meal("donburi", [
			{ name: "japanese eggplant", qty: 600, unit: "g" },
			{ name: "gochujang", qty: 3, unit: "tbsp" },
			{ name: "soy sauce", qty: 2, unit: "tbsp" },
			{ name: "rice vinegar", qty: 1, unit: "tbsp" },
			{ name: "jasmine rice", qty: 300, unit: "g" },
			{ name: "egg", qty: 2, unit: "whole" },
			{ name: "garlic", qty: 4, unit: "clove" },
			{ name: "scallion", qty: 3, unit: "stalk" },
			{ name: "sesame oil", qty: 1, unit: "tbsp" },
		]);
		fillComponents(donburiMeal as any, []);
		const dComps = (donburiMeal as any).components as Array<{ role: string; source: any }>;
		const dStarch = dComps.find(c => c.role === "starch");
		const dStarchRaws = (dStarch?.source?.raw_ingredients || []).map((r: any) => r.name);
		ctx.assert.contains(dStarchRaws, "jasmine rice", "donburi: rice in starch");

		// ── Stir-fry with noodles: noodle should match starch keyword ───────
		const stirFryMeal = meal("stir_fry", [
			{ name: "udon noodle", qty: 300, unit: "g" },
			{ name: "firm tofu", qty: 300, unit: "g" },
			{ name: "broccoli", qty: 200, unit: "g" },
			{ name: "soy sauce", qty: 2, unit: "tbsp" },
		]);
		fillComponents(stirFryMeal as any, []);
		const sfComps = (stirFryMeal as any).components as Array<{ role: string; source: any }>;
		const sfStarch = sfComps.find(c => c.role === "starch");
		const sfStarchRaws = (sfStarch?.source?.raw_ingredients || []).map((r: any) => r.name);
		ctx.assert.contains(sfStarchRaws, "udon noodle", "stir_fry: udon noodle in starch (noodle keyword matches)");

		// ── Idempotency: pre-supplied components untouched ─────────────────
		const presetMeal: any = meal("curry", [{ name: "firm tofu", qty: 400, unit: "g" }]);
		presetMeal.components = [
			{ role: "main", required: true, title: "Custom", source: { kind: "compose_inline", raw_ingredients: [{ name: "tofu" }] }, serves: 2, active_time_min: 0 },
		];
		const ret = fillComponents(presetMeal, []);
		ctx.assert.eq(ret, 0, "pre-supplied components are not overwritten (idempotent)");
		ctx.assert.eq(presetMeal.components.length, 1, "still 1 component (untouched)");

		// ── Hollow placeholder still emits when no ingredients can fill ─────
		// (The critic relies on this for empty plans / placeholder shells.)
		const emptyMeal = meal("curry", []); // no ingredients at all
		fillComponents(emptyMeal as any, []);
		const eComps = (emptyMeal as any).components as Array<{ role: string; required: boolean; source: any }>;
		const emptyStarch = eComps.find(c => c.role === "starch");
		// Required role with no ingredients → hollow placeholder so critic fires
		ctx.assert.ok(!!emptyStarch, "empty meal still emits required-slot placeholder");
		ctx.assert.eq(emptyStarch?.source?.raw_ingredients?.length || 0, 0, "placeholder has empty raw_ingredients (critic-flaggable)");
	},
};

export default u78;
