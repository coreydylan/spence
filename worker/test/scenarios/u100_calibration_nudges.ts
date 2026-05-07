// U100 — Onboarding calibration nudges (post-week-1 review).
//
// Pins the four small fixes called out by the first-week simulation:
//
//   1. Pantry threshold lowered: ≥20 → strongly pantry-first,
//      ≥10 → somewhat, ≤4 → shop-fresh, 5-9 → ambiguous.
//   2. Equipment threshold lowered: ≥15 → strongly rich,
//      ≥8 → somewhat, ≤4 → minimalist, 5-7 → ambiguous.
//   3. household_onboarding_status and household_get_next_question must
//      return the SAME engagement_signal for the same household within
//      the same minute — the cached state value drifted from the live
//      computation. Status now recomputes live and refreshes the cache.
//   4. observeFromTool / applyTraitDeltaForHousehold must thread
//      member_id all the way to mise_household_traits so the trait spread
//      analyzer can detect divergence between members of the same
//      household. Schema PK now includes member_id.

import type { Scenario } from "../lib/types";
import { createMockD1 } from "../lib/mock-d1";
import { migrateHouseholdMemorySchema } from "../../src/mise-graph/admin-household-memory";
import { migrateOnboardingSchema } from "../../src/mise-graph/schemas/migrations";
import { migrateEquipmentSchema } from "../../src/mise-graph/equipment";
import {
	setPantryBulk,
	setEquipmentBulk,
} from "../../src/mise-graph/onboarding-bulk";
import {
	listResponses,
	listTraits,
	startOnboarding,
	statusOnboarding,
	applyTraitDeltaForHousehold,
} from "../../src/mise-graph/onboarding";
import { observeResponse } from "../../src/mise-graph/onboarding-observe";
import { handlePlanWorldJsonRpc } from "../../src/mise-graph/plan-world-mcp";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

const u100: Scenario = {
	id: "u100",
	name: "Calibration nudges: thresholds + signal parity + per-member traits",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const db = createMockD1();
		const env = { DB: db as unknown as D1Database } as MiseGraphEnv;
		await migrateHouseholdMemorySchema(env);
		await migrateOnboardingSchema(env);
		await migrateEquipmentSchema(env);

		// ─── Fix 1: Pantry thresholds ─────────────────────────────────────

		const pantry22 = Array.from({ length: 22 }, (_, i) => `staple_${i}`).join("\n");
		const r22 = await setPantryBulk(env, {
			household_id: "hh_u100_p22",
			mode: "text",
			text: pantry22,
		});
		ctx.assert.eq(r22.ok, true, "22-item pantry write ok");
		ctx.assert.gte(r22.items_recorded, 22, "22 items recorded");
		ctx.assert.contains(r22.trait_deltas, "pantry_first_vs_shop_fresh", "22 items fires pantry trait delta");
		const t22 = await listTraits(env, "hh_u100_p22");
		const v22 = t22.find(t => t.trait_name === "pantry_first_vs_shop_fresh");
		ctx.assert.ok(!!v22, "22-item pantry trait persisted");
		ctx.assert.ok(v22!.trait_value < 0.2, `22 items → strongly pantry-first (<0.2), got ${v22!.trait_value}`);
		ctx.assert.gt(v22!.confidence, 0, "confidence > 0");

		const pantry12 = Array.from({ length: 12 }, (_, i) => `staple_${i}`).join("\n");
		const r12 = await setPantryBulk(env, {
			household_id: "hh_u100_p12",
			mode: "text",
			text: pantry12,
		});
		ctx.assert.contains(r12.trait_deltas, "pantry_first_vs_shop_fresh", "12 items fires pantry trait delta");
		const t12 = await listTraits(env, "hh_u100_p12");
		const v12 = t12.find(t => t.trait_name === "pantry_first_vs_shop_fresh");
		ctx.assert.ok(!!v12, "12-item pantry trait persisted");
		ctx.assert.gte(v12!.trait_value, 0.2, "12 items → trait_value ≥ 0.2 (somewhat)");
		ctx.assert.lte(v12!.trait_value, 0.4, "12 items → trait_value ≤ 0.4 (somewhat)");
		ctx.assert.gt(v12!.confidence, 0, "12-item confidence > 0");

		const pantry3 = "olive oil\nsalt\npepper";
		const r3 = await setPantryBulk(env, {
			household_id: "hh_u100_p3",
			mode: "text",
			text: pantry3,
		});
		ctx.assert.contains(r3.trait_deltas, "pantry_first_vs_shop_fresh", "3 items fires pantry trait delta");
		const t3 = await listTraits(env, "hh_u100_p3");
		const v3 = t3.find(t => t.trait_name === "pantry_first_vs_shop_fresh");
		ctx.assert.ok(!!v3, "3-item pantry trait persisted");
		ctx.assert.gt(v3!.trait_value, 0.7, "3 items → trait_value > 0.7 (shop-fresh)");
		ctx.assert.gt(v3!.confidence, 0, "3-item confidence > 0");

		// ─── Fix 2: Equipment thresholds ──────────────────────────────────

		const eq15 = Array.from({ length: 15 }, (_, i) => `slug_${i}`);
		const e15 = await setEquipmentBulk(env, { household_id: "hh_u100_e15", equipment_slugs: eq15 });
		ctx.assert.contains(e15.trait_deltas, "equipment_rich_vs_minimalist", "15 slugs fires equipment trait");
		const te15 = await listTraits(env, "hh_u100_e15");
		const v15 = te15.find(t => t.trait_name === "equipment_rich_vs_minimalist");
		ctx.assert.ok(!!v15, "15-slug equipment trait persisted");
		ctx.assert.ok(v15!.trait_value < 0.2, `15 slugs → trait_value < 0.2 (rich), got ${v15!.trait_value}`);

		const eq9 = Array.from({ length: 9 }, (_, i) => `slug_${i}`);
		const e9 = await setEquipmentBulk(env, { household_id: "hh_u100_e9", equipment_slugs: eq9 });
		ctx.assert.contains(e9.trait_deltas, "equipment_rich_vs_minimalist", "9 slugs fires equipment trait");
		const te9 = await listTraits(env, "hh_u100_e9");
		const v9 = te9.find(t => t.trait_name === "equipment_rich_vs_minimalist");
		ctx.assert.ok(!!v9, "9-slug equipment trait persisted");
		ctx.assert.gte(v9!.trait_value, 0.2, "9 slugs → trait_value ≥ 0.2 (somewhat)");
		ctx.assert.lte(v9!.trait_value, 0.5, "9 slugs → trait_value ≤ 0.5 (somewhat)");

		const eq3 = ["chefs_knife", "skillet", "cutting_board"];
		const e3 = await setEquipmentBulk(env, { household_id: "hh_u100_e3", equipment_slugs: eq3 });
		ctx.assert.contains(e3.trait_deltas, "equipment_rich_vs_minimalist", "3 slugs fires equipment trait");
		const te3 = await listTraits(env, "hh_u100_e3");
		const v3eq = te3.find(t => t.trait_name === "equipment_rich_vs_minimalist");
		ctx.assert.ok(!!v3eq, "3-slug equipment trait persisted");
		ctx.assert.gt(v3eq!.trait_value, 0.7, "3 slugs → trait_value > 0.7 (minimalist)");

		// 5-7 ambiguous band → no delta
		const e6 = await setEquipmentBulk(env, {
			household_id: "hh_u100_e6",
			equipment_slugs: ["a", "b", "c", "d", "e", "f"],
		});
		ctx.assert.eq(e6.trait_deltas.length, 0, "6 slugs → ambiguous middle, no delta");

		// ─── Fix 3: Engagement signal parity ──────────────────────────────

		const HH_SIGNAL = "hh_u100_signal";
		await startOnboarding(env, { household_id: HH_SIGNAL });
		// Seed a couple of responses so engagement signal isn't the empty default.
		const now = Date.now();
		for (let i = 0; i < 4; i++) {
			await env.DB.prepare(
				`INSERT OR REPLACE INTO mise_onboarding_responses
					(response_id, household_id, member_id, question_kind, question_text,
					 response_text, response_chars, asked_at_ms, answered_at_ms,
					 inferred_traits_json, tier)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).bind(
				`obr_${HH_SIGNAL}_${i}`,
				HH_SIGNAL,
				null,
				`q_${i}`,
				"What do you cook on Tuesdays?",
				"a fairly long answer that should bump the chars/60 ratio above one",
				64,
				now - (i + 1) * 60_000,
				now - (i + 1) * 60_000,
				null,
				1,
			).run();
		}

		const status = await statusOnboarding(env, { household_id: HH_SIGNAL });
		const rpcResult = await handlePlanWorldJsonRpc({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "household_get_next_question", arguments: { household_id: HH_SIGNAL } },
		}, env) as { result?: { structuredContent?: { engagement_signal: number } } };
		ctx.assert.ok(!!rpcResult.result, "next_question RPC returned result");
		const next = rpcResult.result?.structuredContent;
		ctx.assert.ok(!!next, "next_question structuredContent present");
		// Both callers MUST agree to within rounding (round3 → 1e-3 tolerance).
		ctx.assert.lte(
			Math.abs(status.engagement_signal - next!.engagement_signal),
			1e-3,
			`engagement_signal parity: status=${status.engagement_signal} next=${next!.engagement_signal}`,
		);

		// ─── Fix 4: Per-member trait persistence ──────────────────────────

		const HH_MEMBERS = "hh_u100_members";
		await startOnboarding(env, { household_id: HH_MEMBERS });

		// Direct writer: applyTraitDeltaForHousehold with member_id="mem_corey".
		const w1 = await applyTraitDeltaForHousehold(
			env,
			HH_MEMBERS,
			"comfort_vs_adventure",
			1.0,
			0.3,
			{ member_id: "mem_corey" },
		);
		ctx.assert.eq(w1.written, true, "applyTraitDeltaForHousehold persisted the row");
		ctx.assert.eq(w1.member_id, "mem_corey", "result echoes member_id");

		const traitsAfterW1 = await listTraits(env, HH_MEMBERS);
		const corey = traitsAfterW1.find(t =>
			t.trait_name === "comfort_vs_adventure" && t.member_id === "mem_corey",
		);
		ctx.assert.ok(!!corey, "(household, trait, mem_corey) row exists");
		ctx.assert.gt(corey!.trait_value, 0.5, "Corey leans toward adventure (1.0 delta)");

		// Now write for mem_katrina with the OPPOSITE direction.
		await applyTraitDeltaForHousehold(
			env,
			HH_MEMBERS,
			"comfort_vs_adventure",
			0.0,
			0.3,
			{ member_id: "mem_katrina" },
		);
		const traitsAfterW2 = await listTraits(env, HH_MEMBERS);
		const katrina = traitsAfterW2.find(t =>
			t.trait_name === "comfort_vs_adventure" && t.member_id === "mem_katrina",
		);
		ctx.assert.ok(!!katrina, "(household, trait, mem_katrina) row exists alongside Corey");
		ctx.assert.ok(katrina!.trait_value < 0.5, `Katrina leans toward comfort (0.0 delta), got ${katrina!.trait_value}`);
		// Crucially the two rows must coexist — old PK would have collapsed them.
		const memberRows = traitsAfterW2.filter(t =>
			t.trait_name === "comfort_vs_adventure"
			&& t.member_id !== null
			&& t.member_id !== "",
		);
		ctx.assert.eq(memberRows.length, 2, "two member-scoped trait rows coexist");

		// observeFromTool path: feeding member_id through observeResponse should
		// write BOTH a response row and a per-member trait row.
		const obs = await observeResponse(env, {
			household_id: HH_MEMBERS,
			observation_kind: "meal_eaten",
			observation_text: "katrina ate the cabbage",
			member_id: "mem_katrina",
			inferred_traits: [{
				trait_name: "comfort_vs_adventure",
				delta_value: 0.0,
				delta_confidence: 0.3,
			}],
		});
		ctx.assert.eq(obs.recorded, true, "observation recorded");
		ctx.assert.eq(obs.traits_updated, 1, "one trait updated");

		const responses = await listResponses(env, HH_MEMBERS);
		const observedKatrina = responses.find(r =>
			r.member_id === "mem_katrina" && r.question_kind.startsWith("_observed:"),
		);
		ctx.assert.ok(!!observedKatrina, "observation response row tagged with mem_katrina");

		const traitsAfterObs = await listTraits(env, HH_MEMBERS);
		const katrina2 = traitsAfterObs.find(t =>
			t.trait_name === "comfort_vs_adventure" && t.member_id === "mem_katrina",
		);
		ctx.assert.ok(!!katrina2, "Katrina trait row still exists after observation");
		ctx.assert.gte(katrina2!.evidence_count, 2, "Katrina evidence_count incremented");

		// ─── Fix 4 backwards-compat: household-level (no member_id) ───────

		const HH_LEGACY = "hh_u100_legacy";
		await startOnboarding(env, { household_id: HH_LEGACY });
		await applyTraitDeltaForHousehold(env, HH_LEGACY, "comfort_vs_adventure", 1.0, 0.3);
		const legacyTraits = await listTraits(env, HH_LEGACY);
		const legacyRow = legacyTraits.find(t => t.trait_name === "comfort_vs_adventure");
		ctx.assert.ok(!!legacyRow, "household-level row written when member_id omitted");
		// Stored as '' (Phase D normalisation) but the reader returns either
		// null or '' depending on the underlying DB.
		ctx.assert.ok(
			legacyRow!.member_id === null || legacyRow!.member_id === "",
			`household-level row keyed by '' or NULL, got ${legacyRow!.member_id}`,
		);

		ctx.notes.push(`u100 pantry deltas: 22→${v22!.trait_value} 12→${v12!.trait_value} 3→${v3!.trait_value}`);
		ctx.notes.push(`u100 equipment deltas: 15→${v15!.trait_value} 9→${v9!.trait_value} 3→${v3eq!.trait_value}`);
		ctx.notes.push(`u100 engagement_signal parity: status=${status.engagement_signal}, next=${next!.engagement_signal}`);
		ctx.notes.push(`u100 multi-member rows: corey=${corey!.trait_value} katrina=${katrina!.trait_value}`);
	},
};

export default u100;
