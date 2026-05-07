// U35 — Per-person presence: ping, snapshot, available list, stale timeout.

import type { Scenario } from "../lib/types";
import { createMockD1 } from "../lib/mock-d1";
import { migrateHouseholdMemorySchema } from "../../src/mise-graph/admin-household-memory";
import { upsertMember } from "../../src/mise-graph/household-members";
import {
	getPresence,
	listAvailableMembers,
	pingPresence,
	timeoutStalePresence,
} from "../../src/mise-graph/member-presence";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

const u35: Scenario = {
	id: "u35",
	name: "Member presence: ping/get/list/timeout",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const db = createMockD1();
		const env = { DB: db as unknown as D1Database } as MiseGraphEnv;
		const migration = await migrateHouseholdMemorySchema(env);
		ctx.assert.contains(migration.migrated, "mise_member_presence", "migration creates presence table");

		// Build a household with three members.
		await upsertMember(env, { member_id: "mem_a", household_id: "hh_a", display_name: "Alice", age_group: "adult" });
		await upsertMember(env, { member_id: "mem_b", household_id: "hh_a", display_name: "Bob", age_group: "adult" });
		await upsertMember(env, { member_id: "mem_c", household_id: "hh_a", display_name: "Cleo", age_group: "kid" });

		// 1. With no pings, getPresence returns absent.
		const empty = await getPresence(env, "mem_a");
		ctx.assert.eq(empty.state, "absent", "no presence row → absent");
		ctx.assert.eq(empty.current_task_id, null, "no task on empty presence");
		ctx.assert.eq(empty.last_ping_at, null, "no last_ping_at on empty presence");

		// 2. Ping + getPresence round-trip.
		await pingPresence(env, { member_id: "mem_a", state: "in_kitchen_idle" });
		const aSnap = await getPresence(env, "mem_a");
		ctx.assert.eq(aSnap.state, "in_kitchen_idle", "Alice ping persisted");
		ctx.assert.ok(!!aSnap.last_ping_at, "last_ping_at recorded");
		ctx.assert.gte(aSnap.ms_since_ping, 0, "ms_since_ping computed");

		await pingPresence(env, {
			member_id: "mem_b",
			state: "busy_assigned",
			current_task_id: "task:onion_dice",
			current_session_id: "sess_1",
		});
		const bSnap = await getPresence(env, "mem_b");
		ctx.assert.eq(bSnap.state, "busy_assigned", "Bob marked busy");
		ctx.assert.eq(bSnap.current_task_id, "task:onion_dice", "Bob's current_task_id stored");

		// Cleo never pings.

		// 3. listAvailableMembers — only members in_kitchen_idle or busy_assigned.
		const available = await listAvailableMembers(env, "hh_a");
		ctx.assert.eq(available.length, 2, "two members available (Alice + Bob)");
		ctx.assert.eq(available[0].presence, "in_kitchen_idle", "in_kitchen_idle sorted before busy");
		ctx.assert.eq(available[0].member_id, "mem_a", "Alice (idle) listed first");
		ctx.assert.eq(available[1].member_id, "mem_b", "Bob (busy) listed second");
		ctx.assert.eq(available.find(m => m.member_id === "mem_c"), undefined, "Cleo (absent) not listed");

		// 4. timeoutStalePresence — flips ancient pings.
		// Manually back-date Alice's last_ping_at so it falls outside the timeout window.
		const ancient = new Date(Date.now() - 10 * 60 * 1000).toISOString();  // 10 min ago
		await env.DB.prepare(
			`UPDATE mise_member_presence SET last_ping_at = ? WHERE member_id = ?`,
		).bind(ancient, "mem_a").run();

		const sweep = await timeoutStalePresence(env, "hh_a", 60);  // 60 sec timeout
		ctx.assert.eq(sweep.flipped_to_stepped_away, 1, "Alice flipped to stepped_away");

		const aAfter = await getPresence(env, "mem_a");
		ctx.assert.eq(aAfter.state, "stepped_away", "Alice's state updated to stepped_away");

		const bAfter = await getPresence(env, "mem_b");
		ctx.assert.eq(bAfter.state, "busy_assigned", "Bob still busy (just pinged within window)");

		// 5. Re-ping Alice — she comes back.
		await pingPresence(env, { member_id: "mem_a", state: "in_kitchen_idle" });
		const aRecovered = await getPresence(env, "mem_a");
		ctx.assert.eq(aRecovered.state, "in_kitchen_idle", "Alice back to idle after re-ping");

		// listAvailable now sees her again.
		const availableAfter = await listAvailableMembers(env, "hh_a");
		ctx.assert.eq(availableAfter.length, 2, "Alice + Bob both available again");

		ctx.notes.push("u35 presence flow ok: ping → list → timeout → re-ping");
	},
};

export default u35;
