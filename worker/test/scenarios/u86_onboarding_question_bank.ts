// U86 — Contract test for the tier-0 / tier-1 question bank: every entry is
// well-formed, kinds are unique, options are non-degenerate, inferred-trait
// rules name known dimensions, and the locked design decisions (dinner_ritual
// options + pantry_intake options) are honored.

import type { Scenario } from "../lib/types";
import {
	TIER_0_QUESTIONS,
	TIER_1_QUESTIONS,
	TRAIT_NAMES,
	allQuestions,
	findQuestion,
	isKnownTraitName,
} from "../../src/mise-graph/onboarding-questions";

const u86: Scenario = {
	id: "u86",
	name: "Onboarding question bank: kind uniqueness, option shape, trait validity",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// 1. Every TIER_0 + TIER_1 question has a unique kind.
		const all = allQuestions();
		const seen = new Set<string>();
		for (const q of all) {
			ctx.assert.eq(seen.has(q.kind), false, `kind '${q.kind}' is unique`);
			seen.add(q.kind);
		}

		// 2. Every question with options has at least 2 distinct values.
		for (const q of all) {
			if (!q.options) continue;
			ctx.assert.gte(q.options.length, 2, `${q.kind} has ≥2 options`);
			const values = new Set(q.options.map(o => o.value));
			ctx.assert.eq(values.size, q.options.length, `${q.kind} option values are distinct`);
			for (const opt of q.options) {
				ctx.assert.ok(typeof opt.value === "string" && opt.value.trim().length > 0, `${q.kind} option value is non-empty string`);
				ctx.assert.ok(typeof opt.label === "string" && opt.label.trim().length > 0, `${q.kind} option label is non-empty string`);
			}
		}

		// 3. Every inferred-trait rule names one of the 7 known TRAIT_NAMES.
		for (const q of all) {
			if (!q.inferred_traits) continue;
			for (const rule of q.inferred_traits) {
				ctx.assert.eq(isKnownTraitName(rule.trait_name), true, `${q.kind} rule references known trait_name (${rule.trait_name})`);
				ctx.assert.gte(rule.delta_value, 0, `${q.kind} delta_value ≥0`);
				ctx.assert.lte(rule.delta_value, 1, `${q.kind} delta_value ≤1`);
				ctx.assert.gt(rule.delta_confidence, 0, `${q.kind} delta_confidence > 0`);
				ctx.assert.lte(rule.delta_confidence, 1, `${q.kind} delta_confidence ≤1`);
				ctx.assert.eq(typeof rule.response_predicate, "function", `${q.kind} response_predicate is callable`);
			}
		}

		// 4. dinner_ritual question has options including 'table', 'tv', 'desk', 'varies'.
		const dinner = findQuestion("tier_1_dinner_ritual");
		ctx.assert.ok(!!dinner, "tier_1_dinner_ritual exists");
		ctx.assert.ok(!!dinner!.options, "dinner_ritual has options");
		const dinnerVals = new Set(dinner!.options!.map(o => o.value));
		ctx.assert.eq(dinnerVals.has("table"), true, "dinner_ritual includes 'table'");
		ctx.assert.eq(dinnerVals.has("tv"), true, "dinner_ritual includes 'tv'");
		ctx.assert.eq(dinnerVals.has("desk"), true, "dinner_ritual includes 'desk'");
		ctx.assert.eq(dinnerVals.has("varies"), true, "dinner_ritual includes 'varies'");

		// 5. pantry_intake question has options 'bulk', 'gradual', 'photo'.
		const pantry = findQuestion("tier_1_pantry_intake");
		ctx.assert.ok(!!pantry, "tier_1_pantry_intake exists");
		ctx.assert.ok(!!pantry!.options, "pantry_intake has options");
		const pantryVals = new Set(pantry!.options!.map(o => o.value));
		ctx.assert.eq(pantryVals.has("bulk"), true, "pantry_intake includes 'bulk'");
		ctx.assert.eq(pantryVals.has("gradual"), true, "pantry_intake includes 'gradual'");
		ctx.assert.eq(pantryVals.has("photo"), true, "pantry_intake includes 'photo'");

		// 6. TRAIT_NAMES has exactly the 7 personality dimensions.
		ctx.assert.eq(TRAIT_NAMES.length, 7, "TRAIT_NAMES has 7 dimensions");

		// 7. Tier separation: TIER_0 entries all .tier === 0, TIER_1 entries all .tier === 1.
		for (const q of TIER_0_QUESTIONS) ctx.assert.eq(q.tier, 0, `${q.kind} is in tier 0`);
		for (const q of TIER_1_QUESTIONS) ctx.assert.eq(q.tier, 1, `${q.kind} is in tier 1`);

		// 8. dinner_ritual rules cover both ritual end (table) and refueling end (desk/tv).
		const ritualRules = dinner!.inferred_traits || [];
		ctx.assert.gte(ritualRules.length, 2, "dinner_ritual has at least 2 trait rules");
		const ritualMatchTable = ritualRules.find(r => r.response_predicate("table"));
		ctx.assert.ok(!!ritualMatchTable, "a rule matches 'table'");
		ctx.assert.eq(ritualMatchTable!.delta_value, 0.0, "'table' delta_value = 0.0 (toward ritual)");
		const ritualMatchDesk = ritualRules.find(r => r.response_predicate("desk"));
		ctx.assert.ok(!!ritualMatchDesk, "a rule matches 'desk'");
		ctx.assert.eq(ritualMatchDesk!.delta_value, 1.0, "'desk' delta_value = 1.0 (toward refueling)");
		const ritualMatchTv = ritualRules.find(r => r.response_predicate("tv"));
		ctx.assert.ok(!!ritualMatchTv, "a rule matches 'tv'");

		// 9. findQuestion returns null for unknown kinds.
		ctx.assert.eq(findQuestion("not_a_real_kind"), null, "findQuestion returns null for unknown kind");

		ctx.notes.push(`u86 question count: tier0=${TIER_0_QUESTIONS.length}, tier1=${TIER_1_QUESTIONS.length}, traits=${TRAIT_NAMES.length}`);
	},
};

export default u86;
