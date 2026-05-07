// U34 — Per-person HouseholdMember model: CRUD, default skills/safety,
// skill auto-learning, eligibility checks.

import type { Scenario } from "../lib/types";
import { createMockD1 } from "../lib/mock-d1";
import { migrateHouseholdMemorySchema } from "../../src/mise-graph/admin-household-memory";
import {
	canMemberDoTask,
	defaultSafetyFor,
	defaultSkillsFor,
	deleteMember,
	getMember,
	listMembers,
	recordSkillOutcome,
	upsertMember,
} from "../../src/mise-graph/household-members";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

const u34: Scenario = {
	id: "u34",
	name: "Household members: CRUD + default skills + skill auto-learning + eligibility",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const db = createMockD1();
		const env = { DB: db as unknown as D1Database } as MiseGraphEnv;
		const migration = await migrateHouseholdMemorySchema(env);
		ctx.assert.contains(migration.migrated, "mise_household_members", "migration creates members table");
		ctx.assert.contains(migration.migrated, "mise_member_skills", "migration creates skills table");
		ctx.assert.contains(migration.migrated, "mise_member_skill_history", "migration creates skill history table");

		// 1. Default skills/safety helpers shape correctly.
		const adultSkills = defaultSkillsFor("adult");
		ctx.assert.gt(adultSkills.length, 4, "adult has multiple default skills");
		ctx.assert.ok(!!adultSkills.find(s => s.skill_name === "saute"), "adult has saute skill");
		ctx.assert.ok(!!adultSkills.find(s => s.skill_name === "knife_basic"), "adult has knife_basic skill");

		const kidSkills = defaultSkillsFor("kid");
		ctx.assert.gt(kidSkills.length, 0, "kid has default skills");
		ctx.assert.ok(!!kidSkills.find(s => s.skill_name === "measuring"), "kid has measuring skill");
		ctx.assert.ok(!!kidSkills.find(s => s.skill_name === "mixing"), "kid has mixing skill");
		ctx.assert.ok(!!kidSkills.find(s => s.skill_name === "washing"), "kid has washing skill");
		ctx.assert.eq(kidSkills.find(s => s.skill_name === "saute"), undefined, "kid has NO saute skill (age-appropriate)");
		ctx.assert.eq(kidSkills.find(s => s.skill_name === "knife_basic"), undefined, "kid has NO knife_basic by default");

		const toddlerSkills = defaultSkillsFor("toddler");
		ctx.assert.gt(toddlerSkills.length, 0, "toddler has at least stirring/pouring");
		ctx.assert.ok(!!toddlerSkills.find(s => s.skill_name === "stirring"), "toddler has stirring");

		const adultSafety = defaultSafetyFor("adult");
		ctx.assert.eq(adultSafety.stove_authorized, true, "adult stove authorized");
		ctx.assert.eq(adultSafety.knife_authorized, true, "adult knife authorized");
		ctx.assert.eq(adultSafety.minimum_supervision, "none", "adult needs no supervision");

		const kidSafety = defaultSafetyFor("kid");
		ctx.assert.eq(kidSafety.stove_authorized, false, "kid stove NOT authorized");
		ctx.assert.eq(kidSafety.knife_authorized, "supervised", "kid knife is supervised");
		ctx.assert.eq(kidSafety.minimum_supervision, "adult", "kid needs adult supervision");

		// 2. upsertMember + getMember round-trip with default skill seeding.
		const adult1 = await upsertMember(env, {
			member_id: "mem_alice",
			household_id: "hh_a",
			display_name: "Alice",
			age_group: "adult",
			dietary: ["pescatarian"],
			preferences: { loves: ["lemon"], dislikes: ["cilantro"], allergies: [] },
		});
		ctx.assert.eq(adult1.member_id, "mem_alice", "upsert returns member_id");
		ctx.assert.eq(adult1.age_group, "adult", "age_group persisted");
		ctx.assert.gt(adult1.skills.length, 0, "default skills seeded");
		ctx.assert.eq(adult1.dietary[0], "pescatarian", "dietary persisted");
		ctx.assert.eq(adult1.preferences.dislikes[0], "cilantro", "preferences persisted");
		ctx.assert.eq(adult1.safety.stove_authorized, true, "default safety: stove authorized for adult");

		const fetched = await getMember(env, "mem_alice");
		ctx.assert.ok(!!fetched, "getMember returns the upserted row");
		ctx.assert.eq(fetched!.display_name, "Alice", "display_name round-trips");
		ctx.assert.gt(fetched!.skills.length, 0, "skills round-trip from skill table");
		ctx.assert.ok(!!fetched!.skills.find(s => s.skill_name === "saute"), "saute skill round-trips");

		// 3. Listing members for a household.
		await upsertMember(env, {
			member_id: "mem_kid1",
			household_id: "hh_a",
			display_name: "Sam",
			age_group: "kid",
		});
		const list = await listMembers(env, "hh_a");
		ctx.assert.eq(list.length, 2, "listMembers returns both members");
		const sam = list.find(m => m.member_id === "mem_kid1")!;
		ctx.assert.eq(sam.age_group, "kid", "kid age group recorded");
		ctx.assert.eq(sam.safety.stove_authorized, false, "kid safety defaults applied");
		ctx.assert.eq(sam.safety.knife_authorized, "supervised", "kid knife = supervised by default");
		ctx.assert.ok(!!sam.skills.find(s => s.skill_name === "measuring"), "kid measuring skill seeded");

		// 4. Partial upsert preserves skills + merges new fields.
		const updated = await upsertMember(env, {
			member_id: "mem_alice",
			household_id: "hh_a",
			display_name: "Alice",
			active_skill_quests: ["learn_dough_basic"],
		});
		ctx.assert.eq(updated.active_skill_quests[0], "learn_dough_basic", "active_skill_quests set");
		ctx.assert.gt(updated.skills.length, 0, "skills preserved on partial upsert");
		ctx.assert.eq(updated.dietary[0], "pescatarian", "dietary preserved on partial upsert");

		// 5. recordSkillOutcome — confidence rises on success.
		const beforeSaute = (await getMember(env, "mem_alice"))!.skills.find(s => s.skill_name === "saute")!;
		const startingConfidence = beforeSaute.confidence;
		const outcome = await recordSkillOutcome(env, {
			member_id: "mem_alice",
			skill_name: "saute",
			outcome: "success",
			duration_actual_min: 8,
			duration_expected_min: 10,
		});
		ctx.assert.gt(outcome.new_confidence, startingConfidence, "success boosts confidence");
		ctx.assert.eq(outcome.tasks_completed, 1, "first task increments completed counter");

		const afterSaute = (await getMember(env, "mem_alice"))!.skills.find(s => s.skill_name === "saute")!;
		ctx.assert.eq(afterSaute.confidence, outcome.new_confidence, "stored confidence matches return value");
		ctx.assert.eq(afterSaute.tasks_completed, 1, "stored tasks_completed matches return value");
		ctx.assert.ok(!!afterSaute.last_used_at, "last_used_at set after recording");
		ctx.assert.lte(afterSaute.speed_multiplier, 1.0, "speed_multiplier reflects faster-than-expected (8/10)");

		// 6. Failure decreases confidence; clamped at 0.
		const fail = await recordSkillOutcome(env, {
			member_id: "mem_alice",
			skill_name: "saute",
			outcome: "failure",
		});
		ctx.assert.lte(fail.new_confidence, outcome.new_confidence, "failure decreases confidence");
		ctx.assert.eq(fail.tasks_completed, 2, "tasks_completed still increments on failure");

		// New skill not previously seeded — recording outcome creates it.
		const newSkill = await recordSkillOutcome(env, {
			member_id: "mem_alice",
			skill_name: "fermentation",
			outcome: "success",
		});
		ctx.assert.eq(newSkill.tasks_completed, 1, "new skill row created with first outcome");
		ctx.assert.gt(newSkill.new_confidence, 0, "new skill earns first confidence bump");

		// History append-only growth — record many failures to test clamp.
		for (let i = 0; i < 50; i++) {
			await recordSkillOutcome(env, {
				member_id: "mem_alice",
				skill_name: "fermentation",
				outcome: "failure",
			});
		}
		const ferm = (await getMember(env, "mem_alice"))!.skills.find(s => s.skill_name === "fermentation")!;
		ctx.assert.gte(ferm.confidence, 0, "confidence clamped at zero (no negative)");
		ctx.assert.lte(ferm.confidence, 1, "confidence clamped at one");

		// 7. canMemberDoTask — adult vs kid for saute task.
		const aliceFresh = (await getMember(env, "mem_alice"))!;
		const samFresh = (await getMember(env, "mem_kid1"))!;

		const sauteTask = {
			required_skill: "saute",
			min_confidence: 0.3,
			safety_required: { stove_authorized: true } as const,
		};
		const adultEligible = canMemberDoTask(aliceFresh, sauteTask);
		ctx.assert.eq(adultEligible.ok, true, "adult eligible for saute task");
		const kidEligible = canMemberDoTask(samFresh, sauteTask);
		ctx.assert.eq(kidEligible.ok, false, "kid not eligible for saute (no skill, no stove)");
		ctx.assert.ok(!!kidEligible.reason, "kid ineligibility includes a reason");

		// Knife — adult ok, kid blocked when unsupervised needed.
		const knifeUnsupervised = canMemberDoTask(samFresh, {
			required_skill: "measuring",
			safety_required: { knife_authorized: true },
		});
		ctx.assert.eq(knifeUnsupervised.ok, false, "kid blocked when unsupervised knife required");

		// 8. Delete member tears down member + skills.
		await deleteMember(env, "mem_kid1");
		const afterDelete = await getMember(env, "mem_kid1");
		ctx.assert.eq(afterDelete, null, "deleted member disappears");
		const remaining = await listMembers(env, "hh_a");
		ctx.assert.eq(remaining.length, 1, "delete removes from list");

		ctx.notes.push(`u34 alice saute confidence after success+failure: ${aliceFresh.skills.find(s => s.skill_name === "saute")!.confidence}`);
	},
};

export default u34;
