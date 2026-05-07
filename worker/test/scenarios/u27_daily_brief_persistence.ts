// U27 — daily-brief persistence round-trip.
//
// Mocks D1 with a small in-memory shim and exercises:
//   saveDailyBrief → getBriefForDate (round-trip)
//   listUndeliveredBriefs (sees the new brief)
//   markBriefDelivered (drops the brief from the undelivered list)
//   saveDailyBrief twice on the same (household, date) is idempotent

import type { Scenario } from "../lib/types";
import {
	saveDailyBrief,
	getBriefForDate,
	listUndeliveredBriefs,
	markBriefDelivered,
} from "../../src/mise-graph/daily-brief";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

const u27: Scenario = {
	id: "u27",
	name: "Daily-brief D1 round-trip: save → read → mark delivered → list undelivered",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const db = new FakeD1();
		const env = { DB: db as unknown as D1Database } as MiseGraphEnv;

		// 1. Save a brief.
		const saved = await saveDailyBrief(env, {
			household_id: "hh_test",
			plan_id: "mise_plan:abc",
			for_date: "2026-05-12",
			brief_text: "Tonight: Pad Thai. Use the shiitake — it's turning tomorrow.",
			brief_meta: { context_summary: { meals: 1, expiring: 1 } },
		});
		ctx.assert.matches(saved.brief_id, /^brief:hh_test:2026-05-12$/, "brief_id derived from household + date");
		ctx.assert.eq(db.briefs.size, 1, "one brief persisted");

		// 2. Read it back.
		const fetched = await getBriefForDate(env, "hh_test", "2026-05-12");
		ctx.assert.ok(!!fetched, "getBriefForDate returns the saved row");
		if (fetched) {
			ctx.assert.eq(fetched.brief_id, saved.brief_id, "brief_id matches");
			ctx.assert.contains(fetched.brief_text, "Pad Thai", "brief_text round-trips");
			ctx.assert.eq((fetched.brief_meta.context_summary as Record<string, unknown>)?.meals, 1, "meta JSON round-trips");
		}

		// 3. Different date → null.
		const missing = await getBriefForDate(env, "hh_test", "2026-05-13");
		ctx.assert.eq(missing, null, "no brief for an unsaved date");

		// 4. Listing undelivered includes the brief we just saved.
		const before = await listUndeliveredBriefs(env, "hh_test");
		ctx.assert.eq(before.length, 1, "one undelivered brief before delivery");
		ctx.assert.eq(before[0].brief_id, saved.brief_id, "undelivered list contains the saved brief");

		// 5. Mark delivered → no longer undelivered.
		await markBriefDelivered(env, saved.brief_id, "push");
		const after = await listUndeliveredBriefs(env, "hh_test");
		ctx.assert.eq(after.length, 0, "no undelivered briefs after marking delivered");
		const row = db.briefs.get(saved.brief_id);
		ctx.assert.ok(!!row, "row still exists in DB");
		if (row) {
			ctx.assert.eq(row.delivered, true, "delivered flag flipped");
			ctx.assert.eq(row.delivery_channel, "push", "delivery_channel recorded");
			ctx.assert.ok(!!row.delivered_at, "delivered_at timestamp set");
		}

		// 6. Idempotent re-save on same (household, date).
		await saveDailyBrief(env, {
			household_id: "hh_test",
			plan_id: "mise_plan:abc",
			for_date: "2026-05-12",
			brief_text: "Updated: shiitake used, Pad Thai under way.",
			brief_meta: { context_summary: { meals: 1, expiring: 0 } },
		});
		ctx.assert.eq(db.briefs.size, 1, "still one row after re-save (upsert)");
		const after2 = await getBriefForDate(env, "hh_test", "2026-05-12");
		ctx.assert.contains(after2?.brief_text || "", "Updated", "second save overwrites the text");
		const row2 = db.briefs.get(saved.brief_id);
		ctx.assert.eq(row2?.delivered, false, "re-save resets delivered flag");

		ctx.notes.push(`u27: round-trip OK; ${db.briefs.size} row(s) at end`);
	},
};

// ─── FakeD1 — minimal shim covering the SQL daily-brief.ts emits ─────────

interface BriefRow {
	brief_id: string;
	household_id: string;
	plan_id: string | null;
	for_date: string;
	generated_at: string;
	brief_text: string;
	brief_meta_json: string | null;
	delivered: boolean;
	delivered_at: string | null;
	delivery_channel: string | null;
}

class FakeD1 {
	briefs = new Map<string, BriefRow>();

	prepare(sql: string): FakeStatement {
		return new FakeStatement(this, sql);
	}
}

class FakeStatement {
	private bindings: unknown[] = [];

	constructor(private readonly db: FakeD1, private readonly sql: string) {}

	bind(...values: unknown[]): this {
		this.bindings = values;
		return this;
	}

	async first<T = unknown>(): Promise<T | null> {
		if (/SELECT\s+brief_id,\s*brief_text,\s*brief_meta_json/i.test(this.sql)) {
			const [household_id, for_date] = this.bindings as [string, string];
			for (const row of this.db.briefs.values()) {
				if (row.household_id === household_id && row.for_date === for_date) {
					return {
						brief_id: row.brief_id,
						brief_text: row.brief_text,
						brief_meta_json: row.brief_meta_json,
					} as T;
				}
			}
			return null;
		}
		return null;
	}

	async all<T = unknown>(): Promise<{ results: T[] }> {
		if (/SELECT\s+brief_id,\s*for_date,\s*brief_text/i.test(this.sql)) {
			const [household_id] = this.bindings as [string];
			const out: BriefRow[] = [];
			for (const row of this.db.briefs.values()) {
				if (row.household_id === household_id && !row.delivered) out.push(row);
			}
			out.sort((a, b) => b.for_date.localeCompare(a.for_date));
			return {
				results: out.map(r => ({
					brief_id: r.brief_id,
					for_date: r.for_date,
					brief_text: r.brief_text,
				})) as T[],
			};
		}
		return { results: [] };
	}

	async run(): Promise<unknown> {
		// INSERT … ON CONFLICT DO UPDATE for mise_daily_briefs
		if (/INSERT\s+INTO\s+mise_daily_briefs/i.test(this.sql)) {
			const [
				brief_id, household_id, plan_id, for_date, generated_at,
				brief_text, brief_meta_json,
			] = this.bindings as [string, string, string | null, string, string, string, string];
			const row: BriefRow = {
				brief_id,
				household_id,
				plan_id,
				for_date,
				generated_at,
				brief_text,
				brief_meta_json,
				delivered: false,
				delivered_at: null,
				delivery_channel: null,
			};
			this.db.briefs.set(brief_id, row);
			return { success: true };
		}
		// UPDATE mise_daily_briefs SET delivered = TRUE …
		if (/UPDATE\s+mise_daily_briefs\s+SET\s+delivered/i.test(this.sql)) {
			const [delivered_at, channel, brief_id] = this.bindings as [string, string, string];
			const row = this.db.briefs.get(brief_id);
			if (row) {
				row.delivered = true;
				row.delivered_at = delivered_at;
				row.delivery_channel = channel;
			}
			return { success: true };
		}
		return { success: true };
	}
}

export default u27;
