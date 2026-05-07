// U58 — Brigade event log: D1 insert + filtered read.
//
// The CookingLeadAgent writes every brigade event to D1.mise_brigade_events
// (as well as the embedded SQLite mirror). Wave 8B's replay UI queries the
// D1 table by cook_session_id. This scenario validates the contract:
//   1. Inserts land with the event id we supplied (PK).
//   2. Querying by cook_session_id returns events in emitted_at_ms ASC.
//   3. Events for a different cook_session_id are NOT returned.
//   4. Event payload survives the JSON round-trip.

import type { Scenario } from "../lib/types";
import { BrigadeFakeD1 } from "../lib/wave7c-fake-d1";
import { migrateBrigadeSchema } from "../../src/mise-graph/schemas/migrations";

interface BrigadeEventDbRow {
	id: string;
	cook_session_id: string;
	kind: string;
	member_id: string | null;
	payload_json: string | null;
	emitted_at_ms: number;
}

const u58: Scenario = {
	id: "u58",
	name: "Brigade events: insert + ordered read by cook_session_id",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const db = new BrigadeFakeD1();
		const env = { DB: db as unknown as D1Database };

		// 1. Migration is idempotent; CREATE TABLE IF NOT EXISTS wrapper.
		const migrated = await migrateBrigadeSchema(env);
		ctx.assert.contains(
			migrated.migrated,
			"mise_brigade_events",
			"migration covers mise_brigade_events",
		);
		ctx.assert.contains(
			migrated.migrated,
			"mise_brigade_pending_tokens",
			"migration covers mise_brigade_pending_tokens",
		);

		// 2. Insert a small event timeline for two cook sessions.
		const SES_A = "cs_alpha";
		const SES_B = "cs_beta";
		const baseNow = 1_750_000_000_000;

		const insert = async (
			id: string,
			cs: string,
			kind: string,
			member: string | null,
			payload: Record<string, unknown>,
			at_offset_ms: number,
		) => {
			await env.DB.prepare(`
				INSERT INTO mise_brigade_events
					(id, cook_session_id, kind, member_id, payload_json, emitted_at_ms)
				VALUES (?, ?, ?, ?, ?, ?)
			`).bind(id, cs, kind, member, JSON.stringify(payload), baseNow + at_offset_ms).run();
		};

		// Insert out-of-order to verify ORDER BY emitted_at_ms ASC works.
		await insert("e3", SES_A, "task_completed", "alice", { task_id: "t1" }, 30_000);
		await insert("e1", SES_A, "session_initialized", null, { meal_id: "m_a" }, 0);
		await insert("e2", SES_A, "member_joined", "alice", { connection_id: "c1" }, 10_000);
		await insert("e_b1", SES_B, "session_initialized", null, { meal_id: "m_b" }, 5_000);

		ctx.assert.eq(db.events.length, 4, "all four events landed");

		// 3. Query by cook_session_id.
		const queryA = await env.DB.prepare(`
			SELECT id, cook_session_id, kind, member_id, payload_json, emitted_at_ms
			FROM mise_brigade_events
			WHERE cook_session_id = ?
			ORDER BY emitted_at_ms ASC
		`).bind(SES_A).all<BrigadeEventDbRow>();

		ctx.assert.eq(queryA.results.length, 3, "cook_session A returned 3 events");
		ctx.assert.eq(queryA.results[0].id, "e1", "first event is the earliest (e1)");
		ctx.assert.eq(queryA.results[1].id, "e2", "second event is e2");
		ctx.assert.eq(queryA.results[2].id, "e3", "third event is e3");
		ctx.assert.eq(
			queryA.results[0].kind,
			"session_initialized",
			"first event kind preserved",
		);

		// 4. Payload round-trips.
		const payload = JSON.parse(queryA.results[2].payload_json || "{}");
		ctx.assert.eq(payload.task_id, "t1", "task_completed payload preserves task_id");

		// 5. Other session is isolated.
		const queryB = await env.DB.prepare(`
			SELECT id, cook_session_id, kind, member_id, payload_json, emitted_at_ms
			FROM mise_brigade_events
			WHERE cook_session_id = ?
			ORDER BY emitted_at_ms ASC
		`).bind(SES_B).all<BrigadeEventDbRow>();

		ctx.assert.eq(queryB.results.length, 1, "cook_session B has exactly its 1 event");
		ctx.assert.eq(queryB.results[0].id, "e_b1", "session B's event id");
	},
};

export default u58;
