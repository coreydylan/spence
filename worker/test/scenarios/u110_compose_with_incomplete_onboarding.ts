// U110 — plan_compose_meal soft-warns when tier 0 onboarding is incomplete.
//
// We do NOT block compose — the agent must remain capable of composing meals
// even if the household hasn't onboarded yet. Instead, the result includes a
// `notes` array entry like "onboarding_incomplete: tier 0 questions not
// answered — meal composed without personality context", which the chef-of-
// staff agent surfaces back to the user.
//
// Once tier 0 is complete the warning disappears.

import type { Scenario } from "../lib/types";
import { callPlanWorldTool } from "../../src/mise-graph/plan-world-mcp";
import { createMockD1 } from "../lib/mock-d1";
import { migrateHouseholdMemorySchema } from "../../src/mise-graph/admin-household-memory";
import { migrateOnboardingSchema } from "../../src/mise-graph/schemas/migrations";
import {
	answerOnboarding,
	startOnboarding,
} from "../../src/mise-graph/onboarding";
import { TIER_0_QUESTIONS } from "../../src/mise-graph/onboarding-questions";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

const u110: Scenario = {
	id: "u110",
	name: "plan_compose_meal: soft-warn 'onboarding_incomplete' note when tier 0 not done",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const env = { DB: createMockD1() } as unknown as MiseGraphEnv;

		// Active plans table is required by the compose flow.
		await env.DB.prepare(`CREATE TABLE IF NOT EXISTS mise_active_plans (
			plan_id TEXT PRIMARY KEY,
			household_id TEXT,
			plan_json TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'draft',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`).run();
		// Onboarding schema must exist so the soft check can read tier_0_completed_at.
		await migrateHouseholdMemorySchema(env);
		await migrateOnboardingSchema(env);

		// ── Case A: NO onboarding state for the household → warning fires ──
		const HH_NO_ONBOARDING = "hh_u110_no_state";
		const planAId = "mise_plan:u110_a";
		const slot = { date: "2026-08-12", slot: "dinner" };
		await callPlanWorldTool("plan_create", {
			plan_id: planAId,
			household_id: HH_NO_ONBOARDING,
			start_date: slot.date,
			end_date: slot.date,
			people_default: 2,
		}, env);

		const composeA = await callPlanWorldTool("plan_compose_meal", {
			plan_id: planAId,
			slot,
			meal: {
				title: "spaghetti aglio e olio",
				format: "pasta",
				cuisine: ["italian"],
				raw_ingredients: [
					{ name: "spaghetti", qty: 200, unit: "g" },
					{ name: "garlic", qty: 4, unit: "clove" },
					{ name: "olive oil", qty: 3, unit: "tbsp" },
				],
			},
		}, env);

		ctx.assert.eq((composeA as { ok?: boolean }).ok, true, "compose still succeeds without onboarding");
		const notesA = (composeA as { notes?: string[] }).notes ?? [];
		ctx.assert.gt(notesA.length, 0, "result.notes populated when tier 0 incomplete");
		ctx.assert.ok(
			notesA.some(n => typeof n === "string" && n.startsWith("onboarding_incomplete")),
			"result.notes contains the onboarding_incomplete entry",
		);
		ctx.assert.ok(
			notesA.some(n => typeof n === "string" && n.includes("personality context")),
			"warning mentions missing personality context",
		);

		// ── Case B: tier_0 in progress (state row exists, no completion stamp) ─
		const HH_T0_PARTIAL = "hh_u110_t0_partial";
		await startOnboarding(env, { household_id: HH_T0_PARTIAL });
		const planBId = "mise_plan:u110_b";
		await callPlanWorldTool("plan_create", {
			plan_id: planBId,
			household_id: HH_T0_PARTIAL,
			start_date: slot.date,
			end_date: slot.date,
			people_default: 2,
		}, env);
		const composeB = await callPlanWorldTool("plan_compose_meal", {
			plan_id: planBId,
			slot,
			meal: {
				title: "stir fry",
				format: "stir_fry",
				cuisine: ["chinese"],
				raw_ingredients: [{ name: "broccoli", qty: 400, unit: "g" }],
			},
		}, env);
		const notesB = (composeB as { notes?: string[] }).notes ?? [];
		ctx.assert.gt(notesB.length, 0, "tier 0 in-progress also surfaces warning");
		ctx.assert.ok(
			notesB.some(n => typeof n === "string" && n.includes("tier 0")),
			"warning text references tier 0",
		);

		// ── Case C: tier_0 done → no warning ───────────────────────────────
		const HH_DONE = "hh_u110_done";
		await startOnboarding(env, { household_id: HH_DONE });
		for (const q of TIER_0_QUESTIONS) {
			const sample = q.options ? q.options[0].value : "Sample answer";
			await answerOnboarding(env, {
				household_id: HH_DONE,
				question_kind: q.kind,
				response_text: sample,
			});
		}

		const planCId = "mise_plan:u110_c";
		await callPlanWorldTool("plan_create", {
			plan_id: planCId,
			household_id: HH_DONE,
			start_date: slot.date,
			end_date: slot.date,
			people_default: 2,
		}, env);
		const composeC = await callPlanWorldTool("plan_compose_meal", {
			plan_id: planCId,
			slot,
			meal: {
				title: "kale salad",
				format: "salad",
				cuisine: ["mediterranean"],
				raw_ingredients: [
					{ name: "kale", qty: 200, unit: "g" },
					{ name: "lemon", qty: 1, unit: "whole" },
				],
			},
		}, env);
		ctx.assert.eq((composeC as { ok?: boolean }).ok, true, "compose succeeds with tier 0 done");
		const notesC = (composeC as { notes?: string[] }).notes;
		// Either the field is absent OR it does not contain an onboarding_incomplete entry.
		const hasWarning = Array.isArray(notesC)
			&& notesC.some(n => typeof n === "string" && n.startsWith("onboarding_incomplete"));
		ctx.assert.eq(hasWarning, false, "no onboarding_incomplete warning once tier 0 complete");

		ctx.notes.push(`u110 case A notes: ${JSON.stringify(notesA)}`);
		ctx.notes.push(`u110 case B notes: ${JSON.stringify(notesB)}`);
	},
};

export default u110;
