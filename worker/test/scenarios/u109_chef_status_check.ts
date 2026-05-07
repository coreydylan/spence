// U109 — Chef-of-staff dispatch: chef_status_check + chef_dispatch.
//
// chef_status_check is the SINGLE TOOL the chef-of-staff agent calls FIRST
// every turn. It tells the agent whether to plan, ask an onboarding question,
// or sneak a hooked tier-2+ question alongside a meal compose. This scenario
// drives the four ladder rungs end-to-end:
//
//   1. Brand-new household: tier 0 incomplete → primary_action =
//      "answer_onboarding_question", blocked_actions includes plan_compose_meal.
//   2. Tier 0 done, tier 1 partial: primary_action = "answer_onboarding_question"
//      but blocked_actions is empty (planning is allowed if user pushes).
//   3. Tier 1 done, no hooked tier-2 firing: primary_action = "ready_to_plan",
//      signals bundle populated (personality summary + traditions + pantry).
//   4. Tier 1 done + a tier-2 hook firing + decent engagement signal:
//      primary_action = "compose_with_inline_question", next_question is the
//      hooked question, signals still populated.
//
// Also covers chef_dispatch — the Phase 1 stub that wraps chef_status_check
// and emits a 1-action turn_plan based on the recommendation.

import type { Scenario } from "../lib/types";
import { createMockD1 } from "../lib/mock-d1";
import { migrateHouseholdMemorySchema } from "../../src/mise-graph/admin-household-memory";
import { migrateOnboardingSchema } from "../../src/mise-graph/schemas/migrations";
import { migrateEquipmentSchema, ensureEquipmentDefined } from "../../src/mise-graph/equipment";
import { addItem } from "../../src/mise-graph/kitchen-inventory";
import { upsertMember } from "../../src/mise-graph/household-members";
import { setTraditions } from "../../src/mise-graph/onboarding-bulk";
import {
	answerOnboarding,
	startOnboarding,
} from "../../src/mise-graph/onboarding";
import { TIER_0_QUESTIONS } from "../../src/mise-graph/onboarding-questions";
import { handlePlanWorldJsonRpc } from "../../src/mise-graph/plan-world-mcp";
import { chefStatusCheck, chefDispatch } from "../../src/mise-graph/chef-dispatch";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

const u109: Scenario = {
	id: "u109",
	name: "Chef dispatch: chef_status_check ladder + chef_dispatch turn plan",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const db = createMockD1();
		const env = { DB: db as unknown as D1Database } as MiseGraphEnv;
		await migrateHouseholdMemorySchema(env);
		await migrateOnboardingSchema(env);
		await migrateEquipmentSchema(env);

		const today = new Date().toISOString().slice(0, 10);

		// ── 1. Brand-new household — no state row yet ────────────────────────
		const HH_NEW = "hh_u109_new";
		// Note: chef_status_check ensures a state row exists internally via
		// statusOnboarding. The household has not started any tier — current_tier
		// will be 0 with no completion stamps.
		const newStatus = await chefStatusCheck(env, { household_id: HH_NEW });
		ctx.assert.eq(newStatus.household_id, HH_NEW, "echoes household_id");
		ctx.assert.eq(newStatus.onboarding.tier_0_done, false, "fresh household: tier_0_done = false");
		ctx.assert.eq(newStatus.onboarding.tier_1_done, false, "fresh household: tier_1_done = false");
		ctx.assert.eq(newStatus.onboarding.current_tier, 0, "current_tier = 0");
		ctx.assert.ok(
			newStatus.onboarding.blocked_actions.includes("plan_compose_meal"),
			"plan_compose_meal is blocked when tier 0 incomplete",
		);
		ctx.assert.gt(newStatus.onboarding.blocked_actions.length, 1, "multiple plan tools blocked");
		ctx.assert.eq(
			newStatus.recommendation.primary_action,
			"answer_onboarding_question",
			"fresh household → recommend answering onboarding question",
		);
		ctx.assert.ok(!!newStatus.recommendation.next_question, "recommendation includes next_question");
		ctx.assert.eq(newStatus.recommendation.next_question!.tier, 0, "next question is tier 0");
		ctx.assert.eq(newStatus.signals, null, "signals are null when tier 0 incomplete");
		ctx.assert.contains(
			newStatus.recommendation.rationale.toLowerCase(),
			"tier 0",
			"rationale references tier 0",
		);

		// chef_dispatch on the same household → turn_plan is a single ask_question.
		const newDispatch = await chefDispatch(env, {
			household_id: HH_NEW,
			user_intent: "plan me dinners this week",
		});
		ctx.assert.eq(newDispatch.turn_plan.length, 1, "fresh household dispatch → 1-action turn plan");
		ctx.assert.eq(newDispatch.turn_plan[0].kind, "ask_question", "first action is ask_question");
		ctx.assert.eq(newDispatch.user_intent, "plan me dinners this week", "user_intent echoed");

		// ── 2. Tier 0 done, tier 1 partial ───────────────────────────────────
		const HH_T0 = "hh_u109_t0";
		await startOnboarding(env, { household_id: HH_T0 });
		// Walk every tier-0 question (required + optional) so tier advances to 1.
		for (const q of TIER_0_QUESTIONS) {
			const sample = q.options ? q.options[0].value : "Sample answer";
			await answerOnboarding(env, {
				household_id: HH_T0,
				question_kind: q.kind,
				response_text: sample,
			});
		}

		const t0Status = await chefStatusCheck(env, { household_id: HH_T0 });
		ctx.assert.eq(t0Status.onboarding.tier_0_done, true, "tier 0 marked done");
		ctx.assert.eq(t0Status.onboarding.tier_1_done, false, "tier 1 still incomplete");
		ctx.assert.eq(t0Status.onboarding.current_tier, 1, "current_tier advanced to 1");
		ctx.assert.eq(
			t0Status.onboarding.blocked_actions.length,
			0,
			"tier 0 done → no blocked actions (planning permitted)",
		);
		ctx.assert.eq(
			t0Status.recommendation.primary_action,
			"answer_onboarding_question",
			"tier 0 done but tier 1 partial → still recommend answering",
		);
		ctx.assert.ok(!!t0Status.recommendation.next_question, "tier 1 question recommended");
		ctx.assert.eq(t0Status.recommendation.next_question!.tier, 1, "next question is tier 1");
		ctx.assert.eq(t0Status.signals, null, "signals still null until tier 1 complete");

		// ── 3. Tier 1 done — ready_to_plan + signals populated ───────────────
		const HH_T1 = "hh_u109_t1";
		await startOnboarding(env, { household_id: HH_T1 });
		for (const q of TIER_0_QUESTIONS) {
			const sample = q.options ? q.options[0].value : "Sample answer";
			await answerOnboarding(env, {
				household_id: HH_T1,
				question_kind: q.kind,
				response_text: sample,
			});
		}
		// Answer all required tier-1 questions. dinner_ritual = "table" fires
		// trait inference toward the ritual end so the personality summary has
		// at least one decisive trait.
		await answerOnboarding(env, {
			household_id: HH_T1,
			question_kind: "tier_1_avoidances",
			response_text: "no shellfish, no peanuts",
		});
		await answerOnboarding(env, {
			household_id: HH_T1,
			question_kind: "tier_1_dinner_ritual",
			response_text: "table",
		});
		// Repeat the answer to push trait confidence above the rendering threshold.
		// We can't re-answer the same kind via the public API (advances tier
		// instead). Instead, write directly into the trait table to simulate
		// observation-pipeline reinforcement.
		await env.DB.prepare(
			`INSERT OR REPLACE INTO mise_household_traits
				(household_id, trait_name, member_id, trait_value, confidence, last_evidence_at_ms, evidence_count)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).bind(HH_T1, "ritual_vs_refueling", "", 0.18, 0.55, Date.now(), 4).run();
		await answerOnboarding(env, {
			household_id: HH_T1,
			question_kind: "tier_1_cook_frequency",
			response_text: "most",
		});
		await answerOnboarding(env, {
			household_id: HH_T1,
			question_kind: "tier_1_pantry_intake",
			response_text: "gradual",
		});

		// Add some richness so the signals bundle is non-trivial.
		await upsertMember(env, {
			household_id: HH_T1,
			display_name: "Corey",
			age_group: "adult",
			dietary: ["vegetarian"],
			preferences: { loves: [], dislikes: [], allergies: [] },
		});
		await setTraditions(env, {
			household_id: HH_T1,
			traditions: [
				{ name: "Friday Pizza Night", cadence: "weekly:friday", description: "homemade pies" },
			],
		});
		for (const slug of ["dutch_oven", "sheet_pan"]) {
			await ensureEquipmentDefined(env, HH_T1, slug);
		}
		await addItem(env, {
			household_id: HH_T1,
			canonical_name: "olive oil",
			qty: null,
			unit: null,
			storage: null,
			acquired_at: today,
			expires_at: null,
			source: "test",
			notes: null,
		});

		const readyStatus = await chefStatusCheck(env, { household_id: HH_T1 });
		ctx.assert.eq(readyStatus.onboarding.tier_0_done, true, "tier 0 done");
		ctx.assert.eq(readyStatus.onboarding.tier_1_done, true, "tier 1 done");
		ctx.assert.gte(readyStatus.onboarding.current_tier, 2, "current_tier advanced to 2+ after tier 1");
		ctx.assert.eq(readyStatus.onboarding.blocked_actions.length, 0, "no blocked actions when ready");
		ctx.assert.eq(
			readyStatus.recommendation.primary_action,
			"ready_to_plan",
			"tier 1 done + no hooks firing → ready_to_plan",
		);
		ctx.assert.ok(!!readyStatus.signals, "signals bundle populated");
		ctx.assert.eq(readyStatus.signals!.household_id, HH_T1, "signals echo household_id");
		ctx.assert.gt(readyStatus.signals!.personality.summary.length, 0, "personality summary rendered");
		ctx.assert.contains(
			readyStatus.signals!.personality.summary,
			"ritual",
			"personality summary mentions ritual lean",
		);
		ctx.assert.eq(readyStatus.signals!.traditions.length, 1, "tradition surfaces in signals");
		ctx.assert.contains(
			readyStatus.signals!.equipment_available,
			"dutch_oven",
			"equipment surfaces in signals",
		);
		ctx.assert.contains(
			readyStatus.signals!.avoidances.dietary,
			"vegetarian",
			"dietary avoidance surfaces in signals",
		);
		ctx.assert.ok(
			!!readyStatus.recommendation.suggested_compose_args,
			"suggested_compose_args populated for ready_to_plan",
		);

		// chef_dispatch on a ready household → ask_user prompt with compose args.
		const readyDispatch = await chefDispatch(env, {
			household_id: HH_T1,
			user_intent: "plan dinners this week please",
		});
		ctx.assert.eq(readyDispatch.turn_plan.length, 1, "ready household → 1-action turn plan");
		ctx.assert.eq(readyDispatch.turn_plan[0].kind, "ask_user", "ready_to_plan emits ask_user");
		ctx.assert.ok(
			!!(readyDispatch.turn_plan[0].args as { suggested_compose_args?: unknown }).suggested_compose_args,
			"turn plan carries suggested_compose_args through",
		);

		// ── 4. Hooked tier-2 question fires alongside ready-to-plan ─────────
		const HH_HOOK = "hh_u109_hook";
		// Set up the state row directly so tier 0+1 are marked complete with
		// timestamps in the past — that way the response log we plant below
		// (with old asked_at_ms) wins the "last 5 answered" filter and the
		// cooldown decay term hits its 1.0 ceiling. Going through the live
		// answerOnboarding path would stamp every response with Date.now()
		// which contaminates the engagement-signal computation.
		const oldAt = Date.now() - 30 * 60 * 60 * 1000; // 30 hours ago
		await env.DB.prepare(
			`INSERT OR REPLACE INTO mise_onboarding_state
				(household_id, current_tier, tier_0_completed_at, tier_1_completed_at,
				 tier_2_completed_at, tier_3_completed_at, active_question_bag_json,
				 engagement_signal, last_question_asked_at, questions_asked_count,
				 questions_answered_count, questions_skipped_count, updated_at_ms)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			HH_HOOK, 2,
			new Date(oldAt).toISOString(),
			new Date(oldAt + 60_000).toISOString(),
			null, null, null, 1.5,
			new Date(oldAt + 60_000).toISOString(),
			10, 10, 0, oldAt,
		).run();
		// Plant a few onboarding responses with old timestamps so engagement
		// signal computation sees a chatty user without us re-asking anything.
		for (let i = 0; i < 6; i++) {
			await env.DB.prepare(
				`INSERT OR REPLACE INTO mise_onboarding_responses
					(response_id, household_id, member_id, question_kind, question_text,
					 response_text, response_chars, asked_at_ms, answered_at_ms,
					 inferred_traits_json, tier)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).bind(
				`obr_seed_${i}`,
				HH_HOOK,
				null,
				`tier_1_seed_${i}`,
				"(seed answer)",
				"a".repeat(200),
				200,
				oldAt + i * 1000,
				oldAt + i * 1000,
				null,
				1,
			).run();
		}

		// Plant a `repeat_ingredient` signal so the tier-2 anchor_repeat hook
		// fires (`deps.repeat_ingredient_count >= 4`). The hooks module reads
		// from `mise_meal_signals`. We INSERT the row directly — the table is
		// schema-on-write in the mock D1, so a CREATE TABLE is needed first.
		await env.DB.prepare(
			`CREATE TABLE IF NOT EXISTS mise_meal_signals (
				household_id TEXT NOT NULL,
				signal_kind TEXT NOT NULL,
				cuisine TEXT,
				streak_length INTEGER,
				ingredient TEXT,
				occurrence_count INTEGER,
				computed_at_ms INTEGER NOT NULL,
				PRIMARY KEY (household_id, signal_kind, computed_at_ms)
			)`,
		).run();
		await env.DB.prepare(
			`INSERT OR REPLACE INTO mise_meal_signals
				(household_id, signal_kind, cuisine, streak_length, ingredient, occurrence_count, computed_at_ms)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).bind(HH_HOOK, "repeat_ingredient", null, null, "tofu", 5, Date.now()).run();


		const hookStatus = await chefStatusCheck(env, { household_id: HH_HOOK });
		ctx.assert.eq(hookStatus.onboarding.tier_1_done, true, "tier 1 done for hook household");
		ctx.assert.eq(
			hookStatus.recommendation.primary_action,
			"compose_with_inline_question",
			"hooked tier-2 firing → compose_with_inline_question",
		);
		ctx.assert.ok(!!hookStatus.recommendation.next_question, "next_question is the hooked question");
		ctx.assert.gte(hookStatus.recommendation.next_question!.tier, 2, "next_question tier is 2+");
		ctx.assert.ok(!!hookStatus.signals, "signals still populated for hooked compose");
		ctx.assert.contains(
			hookStatus.recommendation.rationale.toLowerCase(),
			"hook",
			"rationale references the hook",
		);

		// ── 5. MCP dispatch for both tools ──────────────────────────────────
		const rpcStatus = await handlePlanWorldJsonRpc({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "chef_status_check", arguments: { household_id: HH_NEW } },
		}, env) as { result?: { structuredContent?: { onboarding: { tier_0_done: boolean; blocked_actions: string[] } } } };
		ctx.assert.ok(!!rpcStatus.result, "MCP chef_status_check returns a result");
		ctx.assert.eq(
			rpcStatus.result?.structuredContent?.onboarding.tier_0_done,
			false,
			"MCP echoes tier_0_done",
		);
		ctx.assert.contains(
			rpcStatus.result?.structuredContent?.onboarding.blocked_actions ?? [],
			"plan_compose_meal",
			"MCP surfaces blocked_actions",
		);

		const rpcDispatch = await handlePlanWorldJsonRpc({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: {
				name: "chef_dispatch",
				arguments: { household_id: HH_T1, user_intent: "plan me dinners" },
			},
		}, env) as { result?: { structuredContent?: { turn_plan: Array<{ kind: string }> } } };
		ctx.assert.ok(!!rpcDispatch.result, "MCP chef_dispatch returns a result");
		ctx.assert.eq(
			rpcDispatch.result?.structuredContent?.turn_plan?.length,
			1,
			"MCP chef_dispatch returns a 1-action turn plan",
		);

		ctx.notes.push(`u109 new-household primary_action: ${newStatus.recommendation.primary_action}`);
		ctx.notes.push(`u109 ready primary_action: ${readyStatus.recommendation.primary_action}`);
		ctx.notes.push(`u109 hooked next_question.kind: ${hookStatus.recommendation.next_question?.kind}`);
	},
};

export default u109;
