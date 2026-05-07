// U50 — MemberAgent skills + presence routing.
//
// Covers the helpers MemberAgent wraps: existing recordSkillOutcome /
// canMemberDoTask / pingPresence, plus the new presence-timeout cycle helpers.

import type { Scenario } from "../lib/types";
import { createMockD1 } from "../lib/mock-d1";
import { migrateHouseholdMemorySchema } from "../../src/mise-graph/admin-household-memory";
import {
	canMemberDoTask,
	getMember,
	recordSkillOutcome,
	upsertMember,
} from "../../src/mise-graph/household-members";
import { getPresence, pingPresence } from "../../src/mise-graph/member-presence";
import {
	isMemberPresenceStale,
	nextPresenceSweepAt,
	PRESENCE_ALARM_INTERVAL_MS,
	sweepHouseholdPresence,
} from "../../src/mise-graph/agents/member-cycles";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

const u50: Scenario = {
	id: "u50",
	name: "MemberAgent: skill outcome routing + presence timeout cycle",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const db = createMockD1();
		const env = { DB: db as unknown as D1Database } as MiseGraphEnv;
		await migrateHouseholdMemorySchema(env);

		// ── Seed a household with one adult + one kid ──────────────────────
		await upsertMember(env, {
			member_id: "mem_alice",
			household_id: "hh_a",
			display_name: "Alice",
			age_group: "adult",
		});
		await upsertMember(env, {
			member_id: "mem_kid",
			household_id: "hh_a",
			display_name: "Kid",
			age_group: "kid",
		});

		// ── 1. Skill outcome routing → updates confidence + new tasks_completed ─
		const beforeAlice = await getMember(env, "mem_alice");
		const sauteBefore = beforeAlice!.skills.find(s => s.skill_name === "saute");
		ctx.assert.ok(!!sauteBefore, "alice has saute skill from age-default seed");
		const baseline = sauteBefore!.confidence;

		const outcome = await recordSkillOutcome(env, {
			member_id: "mem_alice",
			skill_name: "saute",
			outcome: "success",
			duration_actual_min: 5,
			duration_expected_min: 5,
			task_id: "task:onion",
			meal_id: "meal:p1:2026-05-13:dinner",
		});
		ctx.assert.gt(outcome.new_confidence, baseline, "confidence rose on success");
		ctx.assert.eq(outcome.tasks_completed, 1, "tasks_completed bumped to 1");

		const failed = await recordSkillOutcome(env, {
			member_id: "mem_alice",
			skill_name: "saute",
			outcome: "failure",
		});
		ctx.assert.lte(failed.new_confidence, outcome.new_confidence, "failure dropped confidence");

		// ── 2. canMemberDoTask routing ─────────────────────────────────────
		const alice = await getMember(env, "mem_alice");
		const canSaute = canMemberDoTask(alice!, { required_skill: "saute", min_confidence: 0.5 });
		ctx.assert.eq(canSaute.ok, true, "alice can saute");

		const kid = await getMember(env, "mem_kid");
		const kidStove = canMemberDoTask(kid!, {
			required_skill: "measuring",
			safety_required: { stove_authorized: true },
		});
		ctx.assert.eq(kidStove.ok, false, "kid blocked by stove safety check");
		ctx.assert.matches(kidStove.reason || "", /stove/i, "reason mentions stove");

		const aliceMissing = canMemberDoTask(alice!, { required_skill: "doesnt_exist" });
		ctx.assert.eq(aliceMissing.ok, false, "missing skill blocks");

		// ── 3. Presence ping + getPresence round-trip ──────────────────────
		await pingPresence(env, { member_id: "mem_alice", state: "in_kitchen_idle" });
		const snap = await getPresence(env, "mem_alice");
		ctx.assert.eq(snap.state, "in_kitchen_idle", "presence persisted");

		// ── 4. isMemberPresenceStale: fresh ping → not stale ───────────────
		const notStale = await isMemberPresenceStale(env, "mem_alice", PRESENCE_ALARM_INTERVAL_MS, new Date());
		ctx.assert.eq(notStale, false, "fresh ping → not stale");

		// ── 5. nextPresenceSweepAt is +30min ───────────────────────────────
		const t0 = new Date("2026-05-13T12:00:00Z");
		const t1 = nextPresenceSweepAt(t0);
		ctx.assert.eq(
			t1.toISOString(),
			"2026-05-13T12:30:00.000Z",
			"nextPresenceSweepAt is +30min",
		);

		// ── 6. sweepHouseholdPresence flips stale members → stepped_away ──
		// Manually backdate the presence row so it's older than the timeout.
		// mock-d1 supports UPDATE … SET … WHERE.
		const oldIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
		await env.DB.prepare(
			`UPDATE mise_member_presence SET last_ping_at = ? WHERE member_id = ?`,
		).bind(oldIso, "mem_alice").run();

		const sweepResult = await sweepHouseholdPresence(env, "hh_a", 30 * 60);
		ctx.assert.eq(sweepResult.flipped, 1, "one stale presence flipped");
		ctx.assert.eq(sweepResult.timeout_sec, 30 * 60, "timeout_sec round-trips");

		const after = await getPresence(env, "mem_alice");
		ctx.assert.eq(after.state, "stepped_away", "presence flipped to stepped_away");

		ctx.notes.push(`alice saute baseline=${baseline} after success=${outcome.new_confidence} after failure=${failed.new_confidence}`);
		ctx.notes.push(`sweep flipped=${sweepResult.flipped}`);
	},
};

export default u50;
