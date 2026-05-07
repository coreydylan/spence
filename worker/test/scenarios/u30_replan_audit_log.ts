// U30 — Audit log round-trip.
//
// recordReplanEvent inserts a row, listReplanEvents reads it back. Verifies
// ordering (most recent first) and that pagination via `limit` works.

import type { Scenario } from "../lib/types";
import { recordReplanEvent, listReplanEvents } from "../../src/mise-graph/replan-audit-log";
import type { ReplanResult } from "../../src/mise-graph/replan-events";

const u30: Scenario = {
	id: "u30",
	name: "Replan audit log: recordReplanEvent → listReplanEvents round-trip",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const db = new FakeD1();
		const env = { DB: db as unknown as D1Database } as { DB: D1Database };

		const planId = "mise_plan:u30";
		const events: ReplanResult[] = [
			makeResult(planId, "skip_meal", "skipped Wed dinner", true),
			makeResult(planId, "lock_slot", "locked Thu lunch", true),
			makeResult(planId, "skip_meal", "could not skip locked Thu lunch", false),
		];

		for (const r of events) {
			await recordReplanEvent(env, r);
		}

		const all = await listReplanEvents(env, planId);
		ctx.assert.eq(all.length, 3, "all three events round-trip");

		// Most recent first — last inserted should be at index 0.
		ctx.assert.eq(all[0].event_kind, "skip_meal", "most recent event is the skip-on-locked-slot");
		ctx.assert.eq(all[0].applied, false, "applied flag round-trips correctly");
		ctx.assert.eq(all[1].event_kind, "lock_slot", "second-most-recent is lock_slot");
		ctx.assert.eq(all[2].event_kind, "skip_meal", "oldest is the first skip");

		// Limit clamping — listReplanEvents respects limit.
		const top1 = await listReplanEvents(env, planId, 1);
		ctx.assert.eq(top1.length, 1, "limit=1 returns only the latest");

		// Other plan ids return empty.
		const other = await listReplanEvents(env, "mise_plan:none");
		ctx.assert.eq(other.length, 0, "unrelated plan_id returns no events");
	},
};

function makeResult(plan_id: string, kind: string, summary: string, applied: boolean): ReplanResult {
	const event = makeEvent(kind);
	return {
		plan_id,
		event,
		applied,
		ripple_summary: {
			affected_meals: 0,
			affected_cooks: 0,
			affected_shop_items: 0,
			new_grievances: 0,
			resolved_grievances: 0,
		},
		details: { new_grievance_messages: [], resolved_grievance_messages: [] },
		warnings: [],
		human_summary: summary,
	};
}

function makeEvent(kind: string): ReplanResult["event"] {
	switch (kind) {
		case "skip_meal":
			return { kind: "skip_meal", slot: { date: "2026-05-13", slot: "dinner" } };
		case "lock_slot":
			return { kind: "lock_slot", slot: { date: "2026-05-14", slot: "lunch" }, reason: "user pinned" };
		default:
			return { kind: "skip_meal", slot: { date: "2026-05-13", slot: "dinner" } };
	}
}

// ---------------------------------------------------------------------------
// Fake D1 — supports the replan-audit-log surface
// ---------------------------------------------------------------------------

interface AuditRow {
	event_id: string;
	plan_id: string;
	event_kind: string;
	event_json: string;
	applied: number;
	applied_at: string;
	ripple_summary_json: string;
	human_summary: string;
}

class FakeD1 {
	rows: AuditRow[] = [];
	private clock = 0;

	prepare(sql: string): FakeStatement {
		return new FakeStatement(this, sql);
	}
	nextTimestamp(): string {
		// Strict ordering — milliseconds aren't guaranteed unique across rapid
		// inserts in the production code, but for a deterministic test a
		// monotonic counter keeps the order assertions stable.
		this.clock += 1;
		return new Date(2026, 4, 6, 9, 0, this.clock).toISOString();
	}
}

class FakeStatement {
	private bindings: unknown[] = [];

	constructor(private readonly db: FakeD1, private readonly sql: string) {}

	bind(...values: unknown[]): this {
		this.bindings = values;
		return this;
	}

	async run(): Promise<unknown> {
		if (/INSERT\s+INTO\s+mise_replan_events/i.test(this.sql)) {
			// Replace the bound applied_at with our monotonic clock so list ordering
			// is deterministic regardless of how fast the test runs.
			const stamp = this.db.nextTimestamp();
			this.db.rows.push({
				event_id: String(this.bindings[0]),
				plan_id: String(this.bindings[1]),
				event_kind: String(this.bindings[2]),
				event_json: String(this.bindings[3]),
				applied: Number(this.bindings[4]),
				applied_at: stamp,
				ripple_summary_json: String(this.bindings[6]),
				human_summary: String(this.bindings[7]),
			});
		}
		return { success: true };
	}

	async first<T = unknown>(): Promise<T | null> {
		return null;
	}

	async all<T = unknown>(): Promise<{ results: T[] }> {
		if (/FROM\s+mise_replan_events/i.test(this.sql)) {
			const planId = String(this.bindings[0]);
			const limit = Number(this.bindings[1]) || 50;
			const matched = this.db.rows
				.filter(r => r.plan_id === planId)
				.slice()
				.sort((a, b) => b.applied_at.localeCompare(a.applied_at))
				.slice(0, limit);
			return { results: matched as unknown as T[] };
		}
		return { results: [] };
	}
}

export default u30;
