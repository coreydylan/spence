// U24 — Conversation threads: start, get, update, close, listing.
//
// Verifies the multi-turn agent context layer: a thread for a household
// can be started, fetched, patched, and closed, and the "active for topic"
// query returns the most recent open thread.

import type { Scenario } from "../lib/types";
import { createMockD1 } from "../lib/mock-d1";
import { migrateHouseholdMemorySchema } from "../../src/mise-graph/admin-household-memory";
import {
	startThread,
	getThread,
	getActiveThreadFor,
	updateThreadState,
	closeThread,
	listRecentThreads,
} from "../../src/mise-graph/conversation-threads";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

const u24: Scenario = {
	id: "u24",
	name: "Conversation threads: start/get/update/close round-trip",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const db = createMockD1();
		const env = { DB: db as unknown as D1Database } as MiseGraphEnv;
		await migrateHouseholdMemorySchema(env);

		// 1. start + get round-trip.
		const t1 = await startThread(env, {
			household_id: "hh_a",
			topic: "weekly_planning",
			active_plan_id: "plan_1",
		});
		ctx.assert.ok(t1.thread_id.length > 0, "startThread returns a thread id");
		ctx.assert.eq(t1.household_id, "hh_a", "household_id stored");
		ctx.assert.eq(t1.topic, "weekly_planning", "topic stored");
		ctx.assert.eq(t1.active_plan_id, "plan_1", "active_plan_id stored");
		ctx.assert.eq(t1.message_count, 0, "fresh thread has zero messages");
		ctx.assert.eq(t1.closed_at, null, "fresh thread is open");

		const fetched = await getThread(env, t1.thread_id);
		ctx.assert.ok(!!fetched, "thread fetched by id");
		ctx.assert.eq(fetched!.thread_id, t1.thread_id, "thread id round-trips");

		// Missing id returns null.
		const none = await getThread(env, "thr_does_not_exist");
		ctx.assert.eq(none, null, "missing thread returns null");

		// 2. updateThreadState merges patches and bumps message_count.
		const updated = await updateThreadState(env, t1.thread_id, {
			focus: "shopping_optimization",
			open_questions: ["which day for tofu shop?"],
		});
		ctx.assert.eq(updated.message_count, 1, "message_count incremented to 1");
		ctx.assert.eq(updated.state["focus"], "shopping_optimization", "state patch stored");

		const updated2 = await updateThreadState(env, t1.thread_id, {
			open_questions: ["resolved"],
			extra_field: 42,
		});
		ctx.assert.eq(updated2.message_count, 2, "message_count incremented to 2");
		ctx.assert.eq(updated2.state["focus"], "shopping_optimization", "earlier state field preserved");
		ctx.assert.eq(updated2.state["extra_field"], 42, "new state field added");
		ctx.assert.eq(
			(updated2.state["open_questions"] as string[])[0],
			"resolved",
			"top-level patch overrides existing key",
		);

		// 3. getActiveThreadFor returns the most recent open thread.
		// Force a slight delay so the second thread's last_turn_at sorts later.
		await new Promise(resolve => setTimeout(resolve, 5));
		const t2 = await startThread(env, {
			household_id: "hh_a",
			topic: "weekly_planning",
		});
		ctx.assert.notEq(t2.thread_id, t1.thread_id, "second thread has unique id");

		const active = await getActiveThreadFor(env, "hh_a", "weekly_planning");
		ctx.assert.ok(!!active, "getActiveThreadFor returns an active thread");
		ctx.assert.eq(active!.thread_id, t2.thread_id, "most recent open thread is returned");

		// Different topic returns null.
		const other = await getActiveThreadFor(env, "hh_a", "leftover_advice");
		ctx.assert.eq(other, null, "no thread for different topic");

		// 4. closeThread + getActiveThreadFor returns null after close.
		await closeThread(env, t2.thread_id);
		const afterClose2 = await getActiveThreadFor(env, "hh_a", "weekly_planning");
		// t1 is still open, so this should now return t1 (the older open one).
		ctx.assert.ok(!!afterClose2, "another open thread on same topic still returns from getActiveThreadFor");
		ctx.assert.eq(afterClose2!.thread_id, t1.thread_id, "falls back to t1 (still open)");

		await closeThread(env, t1.thread_id);
		const noneActive = await getActiveThreadFor(env, "hh_a", "weekly_planning");
		ctx.assert.eq(noneActive, null, "after closing all threads on the topic, getActiveThreadFor returns null");

		// 5. listRecentThreads returns both (closed + open).
		const recents = await listRecentThreads(env, "hh_a", 10);
		ctx.assert.eq(recents.length, 2, "listRecentThreads returns both threads");
		ctx.assert.ok(recents.every(t => !!t.closed_at), "all threads now closed");

		ctx.notes.push(`u24 created ${recents.length} threads, all closed at end`);
	},
};

export default u24;
