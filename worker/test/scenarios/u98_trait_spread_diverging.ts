// U98 — Multi-member trait spread analyzer.
//
// Confirms:
//   * getHouseholdTraitSpread returns one TraitSpread row per trait that has
//     at least one row in mise_household_traits.
//   * "uncalibrated" status when only a household-level row exists or when
//     confidence < 0.2.
//   * "aligned" when divergence ≤ 0.4 across members AND the household-level
//     row has confidence ≥ 0.2.
//   * "diverging" when divergence > 0.4 — the description names the members
//     and recommends alternating / splitting.
//   * household_get_trait_spread MCP tool dispatches to the analyzer and
//     returns the same shape over JSON-RPC.

import type { Scenario } from "../lib/types";
import { createMockD1 } from "../lib/mock-d1";
import { migrateHouseholdMemorySchema } from "../../src/mise-graph/admin-household-memory";
import { migrateOnboardingSchema } from "../../src/mise-graph/schemas/migrations";
import { startOnboarding } from "../../src/mise-graph/onboarding";
import { getHouseholdTraitSpread } from "../../src/mise-graph/onboarding-trait-spread";
import { handlePlanWorldJsonRpc } from "../../src/mise-graph/plan-world-mcp";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

const u98: Scenario = {
	id: "u98",
	name: "Phase D multi-member trait spread: aligned / diverging / uncalibrated",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const db = createMockD1();
		const env = { DB: db as unknown as D1Database } as MiseGraphEnv;
		await migrateHouseholdMemorySchema(env);
		await migrateOnboardingSchema(env);

		await startOnboarding(env, { household_id: "hh_u98" });

		// 1. With no traits at all, getHouseholdTraitSpread returns [].
		const empty = await getHouseholdTraitSpread(env, "hh_u98");
		ctx.assert.eq(empty.length, 0, "no traits → empty array");

		// 2. Insert a household-level row only — should be "uncalibrated"
		// because we can't compare members.
		const now = Date.now();
		await env.DB.prepare(
			`INSERT OR REPLACE INTO mise_household_traits
				(household_id, trait_name, member_id, trait_value, confidence, last_evidence_at_ms, evidence_count)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).bind("hh_u98", "comfort_vs_adventure", null, 0.5, 0.4, now, 2).run();

		const householdOnly = await getHouseholdTraitSpread(env, "hh_u98");
		ctx.assert.eq(householdOnly.length, 1, "one trait spread returned");
		const c1 = householdOnly[0];
		ctx.assert.eq(c1.trait_name, "comfort_vs_adventure", "trait name matches");
		ctx.assert.eq(c1.status, "uncalibrated", "household-only is uncalibrated (no member splits)");
		ctx.assert.eq(c1.member_values.length, 0, "no member readings yet");
		ctx.assert.eq(c1.divergence, 0, "divergence 0 with no members");
		ctx.assert.contains(c1.description, "comfort_vs_adventure", "description names the trait");

		// 3. Inject per-member rows by writing directly into the mock-d1 store.
		// (The real schema PK is (household_id, trait_name) so production INSERT
		// OR REPLACE would collapse the rows. Phase B is expected to ship a
		// schema extension; for Phase D we exercise the reader path which
		// already supports both NULL and member-set rows.)
		const tables = (db as unknown as { __tables: () => Map<string, { rows: Map<string, Record<string, unknown>>; insertion_order: string[] }> }).__tables();
		const traitTable = tables.get("mise_household_traits");
		if (!traitTable) throw new Error("traits table missing");
		// Two members with diverging values on comfort_vs_adventure.
		const coreyKey = "hh_u98|comfort_vs_adventure|corey";
		const katrinaKey = "hh_u98|comfort_vs_adventure|katrina";
		traitTable.rows.set(coreyKey, {
			household_id: "hh_u98",
			trait_name: "comfort_vs_adventure",
			member_id: "corey",
			trait_value: 0.2,
			confidence: 0.7,
			last_evidence_at_ms: now,
			evidence_count: 5,
		});
		traitTable.insertion_order.push(coreyKey);
		traitTable.rows.set(katrinaKey, {
			household_id: "hh_u98",
			trait_name: "comfort_vs_adventure",
			member_id: "katrina",
			trait_value: 0.85,
			confidence: 0.7,
			last_evidence_at_ms: now,
			evidence_count: 5,
		});
		traitTable.insertion_order.push(katrinaKey);

		// Also insert member display names so the description reads naturally.
		await env.DB.prepare(
			`INSERT OR REPLACE INTO mise_household_members
				(member_id, household_id, display_name, age_group, dietary_json,
				 preferences_json, safety_json, active_skill_quests_json, privacy_json,
				 created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind("corey", "hh_u98", "Corey", "adult", "[]", "{}", "{}", "[]", "{}",
			new Date(now).toISOString(), new Date(now).toISOString()).run();
		await env.DB.prepare(
			`INSERT OR REPLACE INTO mise_household_members
				(member_id, household_id, display_name, age_group, dietary_json,
				 preferences_json, safety_json, active_skill_quests_json, privacy_json,
				 created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind("katrina", "hh_u98", "Katrina", "adult", "[]", "{}", "{}", "[]", "{}",
			new Date(now).toISOString(), new Date(now).toISOString()).run();

		const diverging = await getHouseholdTraitSpread(env, "hh_u98");
		ctx.assert.eq(diverging.length, 1, "still one trait spread (only one trait has rows)");
		const c2 = diverging[0];
		ctx.assert.eq(c2.member_values.length, 2, "two member readings");
		ctx.assert.eq(c2.status, "diverging", "0.85 - 0.20 = 0.65 > 0.4 → diverging");
		ctx.assert.gt(c2.divergence, 0.6, "divergence ~0.65");
		ctx.assert.contains(c2.description, "Corey", "description names Corey");
		ctx.assert.contains(c2.description, "Katrina", "description names Katrina");
		ctx.assert.contains(c2.description, "comfort", "description references comfort pole");
		ctx.assert.contains(c2.description, "adventure", "description references adventure pole");
		ctx.assert.matches(c2.description.toLowerCase(), /alternat|split/, "description suggests alternate / split");

		// 4. Aligned case — pull Katrina toward Corey.
		const katrinaRow = traitTable.rows.get(katrinaKey);
		if (!katrinaRow) throw new Error("test setup error");
		katrinaRow.trait_value = 0.3;

		const aligned = await getHouseholdTraitSpread(env, "hh_u98");
		const c3 = aligned[0];
		ctx.assert.eq(c3.status, "aligned", "0.30 - 0.20 = 0.10 ≤ 0.4 → aligned");
		ctx.assert.lte(c3.divergence, 0.15, "divergence ~0.10");
		ctx.assert.contains(c3.description.toLowerCase(), "comfort", "aligned description mentions the lean");

		// 5. household_value across members is the mean.
		ctx.assert.gte(c3.household_value, 0.24, "mean of 0.20 and 0.30 ≈ 0.25");
		ctx.assert.lte(c3.household_value, 0.26, "mean of 0.20 and 0.30 ≈ 0.25");

		// 6. MCP tool dispatch ---------------------------------------------------
		const rpcResult = await handlePlanWorldJsonRpc({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "household_get_trait_spread", arguments: { household_id: "hh_u98" } },
		}, env) as { result?: { structuredContent?: { household_id: string; spreads: Array<{ trait_name: string; status: string }> } } };
		ctx.assert.ok(!!rpcResult.result, "tool returned a result");
		const structured = rpcResult.result?.structuredContent;
		ctx.assert.ok(!!structured, "tool returned structuredContent");
		ctx.assert.eq(structured!.household_id, "hh_u98", "MCP tool echoes household_id");
		ctx.assert.gte(structured!.spreads.length, 1, "MCP tool returns spreads array");
		ctx.assert.eq(structured!.spreads[0].trait_name, "comfort_vs_adventure", "MCP tool surfaces the trait name");

		ctx.notes.push(`u98 diverging description: "${c2.description}"`);
	},
};

export default u98;
