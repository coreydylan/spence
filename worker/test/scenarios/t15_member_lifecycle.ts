// T15 — Per-person household member lifecycle (Wave 6).
//
// Builds a household with 4 members (2 adults, 1 kid, 1 toddler), seeds
// default skills and safety, exercises auto-learning across multiple
// brigade-task outcomes, runs eligibility checks, and asserts that meal
// attendance overrides round-trip through the active-plans store.

import type { Scenario } from "../lib/types";
import { createMockD1 } from "../lib/mock-d1";
import { migrateHouseholdMemorySchema } from "../../src/mise-graph/admin-household-memory";
import {
	canMemberDoTask,
	getMember,
	listMembers,
	recordSkillOutcome,
	upsertMember,
} from "../../src/mise-graph/household-members";
import {
	getPresence,
	listAvailableMembers,
	pingPresence,
} from "../../src/mise-graph/member-presence";
import { callPlanWorldTool } from "../../src/mise-graph/plan-world-mcp";
import type { MiseGraphEnv } from "../../src/mise-graph/types";
import type { MiseWeeklyPlanDraft } from "../../src/mise-graph/planner";

const t15: Scenario = {
	id: "t15",
	name: "Member lifecycle: 2 adults + 1 kid + 1 toddler with skill learning, eligibility, attendance",
	group: "integration",
	tier: "fast",
	async run(ctx) {
		const db = createMockD1();
		const env = { DB: db as unknown as D1Database } as MiseGraphEnv;
		await migrateHouseholdMemorySchema(env);
		// active-plans table — needed for the meal_set_attendance round-trip.
		await env.DB.prepare(`CREATE TABLE IF NOT EXISTS mise_active_plans (
			plan_id TEXT PRIMARY KEY,
			household_id TEXT,
			plan_json TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'draft',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`).run();

		// 1. Create the household (4 members).
		const adult1 = await upsertMember(env, {
			member_id: "mem_adult1",
			household_id: "hh_t15",
			display_name: "Alex",
			age_group: "adult",
		});
		const adult2 = await upsertMember(env, {
			member_id: "mem_adult2",
			household_id: "hh_t15",
			display_name: "Bren",
			age_group: "adult",
		});
		const kid1 = await upsertMember(env, {
			member_id: "mem_kid1",
			household_id: "hh_t15",
			display_name: "Charlie",
			age_group: "kid",
		});
		const toddler1 = await upsertMember(env, {
			member_id: "mem_tod1",
			household_id: "hh_t15",
			display_name: "Dee",
			age_group: "toddler",
		});

		ctx.assert.gt(adult1.skills.length, 0, "adult1 seeded with default skills");
		ctx.assert.gt(adult2.skills.length, 0, "adult2 seeded with default skills");
		ctx.assert.gt(kid1.skills.length, 0, "kid seeded with default skills");
		ctx.assert.gt(toddler1.skills.length, 0, "toddler seeded with default skills");

		// 2. Verify default safety differs by age group.
		ctx.assert.eq(adult1.safety.stove_authorized, true, "adult: stove authorized");
		ctx.assert.eq(adult1.safety.knife_authorized, true, "adult: knife authorized (unsupervised)");
		ctx.assert.eq(adult1.safety.minimum_supervision, "none", "adult: no supervision required");

		ctx.assert.eq(kid1.safety.stove_authorized, false, "kid: stove NOT authorized");
		ctx.assert.eq(kid1.safety.knife_authorized, "supervised", "kid: knife = supervised");
		ctx.assert.eq(kid1.safety.minimum_supervision, "adult", "kid: requires adult supervision");

		ctx.assert.eq(toddler1.safety.stove_authorized, false, "toddler: stove NOT authorized");
		ctx.assert.eq(toddler1.safety.knife_authorized, false, "toddler: knife NOT authorized");

		// 3. Verify default skills differ by age group.
		ctx.assert.ok(!!adult1.skills.find(s => s.skill_name === "saute"), "adult has saute");
		ctx.assert.ok(!!adult1.skills.find(s => s.skill_name === "knife_basic"), "adult has knife_basic");
		ctx.assert.eq(kid1.skills.find(s => s.skill_name === "saute"), undefined, "kid has NO saute");
		ctx.assert.ok(!!kid1.skills.find(s => s.skill_name === "measuring"), "kid has measuring");
		ctx.assert.ok(!!kid1.skills.find(s => s.skill_name === "washing"), "kid has washing");
		ctx.assert.ok(!!toddler1.skills.find(s => s.skill_name === "stirring"), "toddler has stirring");

		// 4. Listing the household returns all four.
		const all = await listMembers(env, "hh_t15");
		ctx.assert.eq(all.length, 4, "listMembers returns all four members");

		// 5. Have an adult complete 5 saute tasks → confidence rises.
		const beforeSaute = (await getMember(env, "mem_adult1"))!
			.skills.find(s => s.skill_name === "saute")!;
		const startConfidence = beforeSaute.confidence;
		for (let i = 0; i < 5; i++) {
			await recordSkillOutcome(env, {
				member_id: "mem_adult1",
				skill_name: "saute",
				outcome: "success",
				duration_actual_min: 9 + i * 0.2,
				duration_expected_min: 10,
			});
		}
		const afterSaute = (await getMember(env, "mem_adult1"))!
			.skills.find(s => s.skill_name === "saute")!;
		ctx.assert.gt(afterSaute.confidence, startConfidence, "5 saute successes raised confidence");
		ctx.assert.eq(afterSaute.tasks_completed, 5, "5 tasks recorded");
		ctx.assert.lte(afterSaute.speed_multiplier, 1.0, "speed_multiplier reflects faster-than-expected runs");

		ctx.notes.push(`adult1 saute confidence: ${startConfidence} → ${afterSaute.confidence}`);
		ctx.notes.push(`adult1 saute speed_multiplier: ${afterSaute.speed_multiplier}`);

		// 6. canMemberDoTask — adult eligible for saute, kid blocked.
		const sauteTask = {
			required_skill: "saute",
			min_confidence: 0.5,
			safety_required: { stove_authorized: true } as const,
		};
		const adultElig = canMemberDoTask(
			(await getMember(env, "mem_adult1"))!,
			sauteTask,
		);
		ctx.assert.eq(adultElig.ok, true, "adult eligible for stove saute");

		const kidElig = canMemberDoTask(
			(await getMember(env, "mem_kid1"))!,
			sauteTask,
		);
		ctx.assert.eq(kidElig.ok, false, "kid blocked from stove saute");

		// Kid attempting a knife task that requires unsupervised authorization is blocked.
		const knifeUnsupervised = canMemberDoTask(
			(await getMember(env, "mem_kid1"))!,
			{ required_skill: "measuring", safety_required: { knife_authorized: true } },
		);
		ctx.assert.eq(knifeUnsupervised.ok, false, "kid blocked when knife requires unsupervised");
		ctx.assert.matches(knifeUnsupervised.reason || "", /knife/i, "block reason mentions knife");

		// Same kid task, but supervised version — passes the safety check.
		const knifeSupervised = canMemberDoTask(
			(await getMember(env, "mem_kid1"))!,
			{ required_skill: "measuring", safety_required: { knife_authorized: "supervised" } },
		);
		ctx.assert.eq(knifeSupervised.ok, true, "kid ok when knife requires only supervised");

		// 7. Presence: adults ping in_kitchen_idle; kid stays absent.
		await pingPresence(env, { member_id: "mem_adult1", state: "in_kitchen_idle" });
		await pingPresence(env, { member_id: "mem_adult2", state: "busy_assigned", current_task_id: "task:slice_onion" });

		const adult1Presence = await getPresence(env, "mem_adult1");
		ctx.assert.eq(adult1Presence.state, "in_kitchen_idle", "adult1 idle");

		const available = await listAvailableMembers(env, "hh_t15");
		ctx.assert.eq(available.length, 2, "two members available (adult1 idle, adult2 busy)");
		ctx.assert.eq(available[0].member_id, "mem_adult1", "idle member sorted first");

		// 8. Set meal attendance via MCP tool — only [adult1, kid1] for one dinner.
		const plan = makeAttendancePlan();
		await callPlanWorldTool("plan_create", { plan }, env);
		const setResult = await callPlanWorldTool("meal_set_attendance", {
			plan_id: plan.id,
			slot: { date: "2026-06-10", slot: "dinner" },
			member_ids: ["mem_adult1", "mem_kid1"],
		}, env);
		ctx.assert.eq(setResult.ok, true, "meal_set_attendance succeeds");

		const readBack = await callPlanWorldTool("meal_read_attendance", {
			plan_id: plan.id,
			slot: { date: "2026-06-10", slot: "dinner" },
		}, env);
		ctx.assert.eq(readBack.uses_default, false, "after override, uses_default = false");
		ctx.assert.eq(
			JSON.stringify(readBack.member_ids),
			JSON.stringify(["mem_adult1", "mem_kid1"]),
			"attendance member_ids round-trip",
		);

		// 9. A separate dinner with no override returns uses_default=true.
		const noOverride = await callPlanWorldTool("meal_read_attendance", {
			plan_id: plan.id,
			slot: { date: "2026-06-11", slot: "dinner" },
		}, env);
		ctx.assert.eq(noOverride.uses_default, true, "untouched meal: uses_default = true");
		ctx.assert.eq(noOverride.member_ids, null, "untouched meal: member_ids = null");

		ctx.notes.push("t15 lifecycle ok: members → skills → eligibility → presence → attendance");
	},
};

function makeAttendancePlan(): MiseWeeklyPlanDraft {
	return {
		id: "mise_plan:t15_attendance",
		household_id: "hh_t15",
		title: "T15 attendance fixture",
		start_date: "2026-06-10",
		end_date: "2026-06-11",
		timezone: "UTC",
		people: 4,
		status: "draft",
		constraints: {},
		selected_ingredients: [],
		source_recipe_ids: [],
		meals_by_day: [
			{
				date: "2026-06-10",
				day_index: 0,
				meals: [{
					id: "meal:wed_dinner",
					date: "2026-06-10",
					slot: "dinner",
					title: "weeknight bowls",
					format: "bowl",
					component_ids: [],
					ingredient_names: [],
					source: "synthetic_test",
					notes: [],
					people: 4,
					cuisine: ["mediterranean"],
					locked: false,
				}],
			},
			{
				date: "2026-06-11",
				day_index: 1,
				meals: [{
					id: "meal:thu_dinner",
					date: "2026-06-11",
					slot: "dinner",
					title: "sheet pan supper",
					format: "sheet_pan",
					component_ids: [],
					ingredient_names: [],
					source: "synthetic_test",
					notes: [],
					people: 4,
					cuisine: ["american"],
					locked: false,
				}],
			},
		],
		component_batches: [],
		prep_tasks: [],
		breakfasts: [],
		snack_boxes: [],
		shopping_list: [],
		shop_runs: [],
		storage_labels: [],
		meta: { generated_by: "mise_graph_planner", deterministic: true },
	};
}

export default t15;
