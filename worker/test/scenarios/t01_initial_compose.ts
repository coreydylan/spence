// T1 — Initial compose meets requirements.
//
// Validates that an LLM-composed plan satisfies the user's hard requirements
// (cuisines, dietary, soft pref) without truncation. Uses a frozen snapshot
// of a real live plan response since hitting the bridge takes ~5 min and
// the assertions are structural, not exact.

import type { Scenario } from "../lib/types";

interface PlanSnapshot {
	plan?: {
		meals_by_day?: Array<{ date: string; meals: Array<{ slot: string; title: string; cuisine: string[]; raw_ingredients?: Array<{ name: string }>; leftovers_to?: string[]; component_ids?: string[]; format?: string }> }>;
		meta?: { compose_mode?: string; llm_meals?: number; llm_debug?: { output_tokens?: number } };
	};
}

const t01: Scenario = {
	id: "t01",
	name: "Initial compose meets cuisine + dietary + leftover requirements",
	group: "golden",
	tier: "fast",
	async run(ctx) {
		const intent = ctx.loadFixture<Record<string, unknown>>("intent-7day-dinners-veg.json");
		const snapshot = ctx.loadFixture<PlanSnapshot>("snapshot-14day-veg-plan.json");
		const plan = snapshot.plan;
		ctx.assert.ok(!!plan, "snapshot has plan field");
		const meta = plan!.meta || {};

		// 1. Compose mode must be LLM (not deterministic fallback)
		ctx.assert.eq(meta.compose_mode, "llm", "compose_mode is 'llm' (not deterministic fallback)");

		// 2. LLM meal count is reasonable for the window
		ctx.assert.gt(meta.llm_meals || 0, 20, "llm produced >20 meals (full window populated)");

		// 3. Output tokens within healthy bounds (no truncation)
		const outTokens = meta.llm_debug?.output_tokens || 0;
		ctx.assert.gt(outTokens, 5000, "output_tokens > 5k (substantial response)");
		ctx.assert.lte(outTokens, 64000, "output_tokens < 64k (no truncation)");

		const dinners = (plan!.meals_by_day || [])
			.flatMap(d => d.meals)
			.filter(m => m.slot === "dinner");
		ctx.notes.push(`dinners present: ${dinners.length}`);
		ctx.assert.gte(dinners.length, 7, "≥7 dinners in plan");

		// 4. Required cuisines present (any from each accepted set)
		const accept = (intent._test_assertions as { must_include_cuisines_any_of: string[][] }).must_include_cuisines_any_of;
		for (const requirementSet of accept) {
			const matched = dinners.some(m => m.cuisine?.some(c => requirementSet.includes(c)));
			const groupLabel = requirementSet.slice(0, 3).join("/") + "...";
			ctx.assert.ok(matched, `at least one dinner cuisine in {${groupLabel}}`);
		}

		// 5. Dietary clean — no fish_sauce / chicken / beef in any raw_ingredient
		const NON_VEG = /fish sauce|anchov|oyster sauce|chicken|beef|pork|bacon|salmon|tuna|prawn|shrimp/i;
		const dietaryViolations = dinners.flatMap(m =>
			(m.raw_ingredients || [])
				.filter(r => NON_VEG.test(r.name || ""))
				.map(r => `${m.title}: ${r.name}`));
		ctx.assert.eq(dietaryViolations.length, 0, "0 dietary violations across dinners");
		if (dietaryViolations.length) ctx.notes.push("violations: " + dietaryViolations.slice(0, 3).join("; "));

		// 6. Soft pref: ≥4 dinners yield leftovers
		const withLeftovers = dinners.filter(m => (m.leftovers_to || []).length > 0).length;
		ctx.notes.push(`dinners with leftovers_to populated: ${withLeftovers}/${dinners.length}`);
		ctx.assert.gte(withLeftovers, 4, "≥4 dinners declare leftovers_to");

		// 7. Format diversity — at least 5 unique dinner formats
		const uniqueFormats = new Set(dinners.map(m => m.format || ""));
		ctx.notes.push(`unique dinner formats: ${uniqueFormats.size}`);
		ctx.assert.gte(uniqueFormats.size, 5, "≥5 unique dinner formats");

		// 8. Component reuse — every dinner should reference at least one component_id (post-pass auto-link)
		const dinnersHookedToBatches = dinners.filter(m => (m.component_ids || []).length > 0).length;
		const reuseRate = dinnersHookedToBatches / dinners.length;
		ctx.notes.push(`dinners with component_ids: ${dinnersHookedToBatches}/${dinners.length} (${(reuseRate * 100).toFixed(0)}%)`);
		ctx.assert.gte(reuseRate, 0.5, "≥50% of dinners reference a component batch (post-pass formula auto-link working at all)");
	},
};

export default t01;
