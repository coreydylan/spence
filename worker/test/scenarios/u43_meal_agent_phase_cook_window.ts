// U43 — MealAgent cook_window entry handler.
//
// cook_window_entry runs three side-effects:
//   1. Claims equipment via the equipment-stub (Wave 7B-C will replace).
//   2. Emits one `member_call` notification per adult member.
//   3. Writes a briefing row capturing weather + claim summary.
//
// Contract:
//   - n adults → n notifications, all with kind="member_call".
//   - Equipment claim returns ok=true on a fresh sink.
//   - A second meal claiming the SAME equipment in an OVERLAPPING window
//     emits a conflict (the in-DO stub detects intra-DO conflicts; real
//     cross-meal conflicts land in Wave 7B-C).
//   - next_alarm_at_ms = cook_window_start_ms + 30min (or now+30m if start
//     already passed).

import type { Scenario } from "../lib/types";
import type { MiseGraphEnv } from "../../src/mise-graph/types";
import {
	cook_window_entry,
	defaultWindowsForSlot,
	type MealSnapshot,
} from "../../src/mise-graph/agents/meal-phase-handlers";
import { type AgentSqlSink } from "../../src/mise-graph/agents/base";

const u43: Scenario = {
	id: "u43",
	name: "MealAgent cook_window entry: equipment claim + member_call fan-out",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const date = "2026-05-13";
		const windows = defaultWindowsForSlot(date, "dinner");
		const now_ms = windows.cook_window_start_ms; // open the cook window

		const snapshot: MealSnapshot = {
			meal_id: "meal:p1:2026-05-13:dinner",
			plan_id: "p1",
			household_id: "hh_a",
			date,
			slot: "dinner",
			format: "skillet",
			cuisine: ["mediterranean"],
			recipe_id: "recipe:lemon_chicken",
			cook_window_start_ms: windows.cook_window_start_ms,
			cook_window_end_ms:   windows.cook_window_end_ms,
			eat_window_start_ms:  windows.eat_window_start_ms,
			eat_window_end_ms:    windows.eat_window_end_ms,
			equipment: ["12in skillet", "oven"],
		};

		const env = { DB: { prepare: () => new FakeStmt() } } as unknown as MiseGraphEnv;
		const sink = makeFakeSqlSink();

		// ── First claim succeeds, fans out 2 notifications ─────────────────
		const r1 = await cook_window_entry(snapshot, {
			env,
			now_ms,
			adults: { adult_member_ids: ["m_corey", "m_sara", ""] }, // empty trimmed
		}, sink);

		ctx.assert.eq(r1.phase, "cook_window", "phase=cook_window");
		ctx.assert.eq(r1.briefings.length, 1, "exactly one briefing emitted");
		ctx.assert.eq(r1.briefings[0].kind, "cook_window", "briefing kind=cook_window");
		ctx.assert.eq(r1.notifications.length, 2, "two notifications (empty member id skipped)");
		ctx.assert.eq(r1.notifications[0].kind, "member_call", "notification kind=member_call");
		ctx.assert.eq(r1.notifications[0].source_agent_kind, "meal_agent", "source agent kind");
		ctx.assert.eq(r1.notifications[0].source_agent_id, snapshot.meal_id, "source agent id = meal_id");
		ctx.assert.contains(
			r1.notifications[0].title,
			"Cook window open",
			"title mentions cook window opening",
		);
		ctx.assert.ok(!!r1.equipment_claim, "equipment_claim present in result");
		ctx.assert.eq(r1.equipment_claim!.ok, true, "first claim succeeds");
		ctx.assert.eq(r1.equipment_claim!.claims.length, 2, "claimed both pieces of equipment");
		ctx.assert.eq(r1.equipment_claim!.conflicts.length, 0, "no conflicts on fresh sink");

		// ── Second meal overlapping the same equipment in same sink hits a
		//    conflict (stub uses meal_id as the discriminator) ─────────────
		const snapshot2: MealSnapshot = {
			...snapshot,
			meal_id: "meal:p1:2026-05-13:dinner_alt",
		};
		const r2 = await cook_window_entry(snapshot2, {
			env,
			now_ms,
			adults: { adult_member_ids: ["m_corey"] },
		}, sink);
		ctx.assert.eq(r2.equipment_claim!.ok, false, "overlapping meal sees ok=false");
		ctx.assert.gte(
			r2.equipment_claim!.conflicts.length,
			1,
			"at least one equipment conflict surfaced",
		);
		ctx.assert.eq(
			r2.equipment_claim!.conflicts[0].conflicting_meal_id,
			snapshot.meal_id,
			"conflict points back at the first meal",
		);

		// ── next_alarm_at_ms = cook_window_start_ms + 30min ───────────────
		const expectedAlarm = snapshot.cook_window_start_ms + 30 * 60 * 1000;
		ctx.assert.eq(
			r1.next_alarm_at_ms,
			expectedAlarm,
			"alarm at cook_window_start + 30min",
		);

		// ── Notification payload roundtrips to JSON cleanly ───────────────
		const payload = JSON.parse(r1.notifications[0].payload_json || "{}") as Record<string, unknown>;
		ctx.assert.eq(payload.meal_id, snapshot.meal_id, "payload meal_id");
		ctx.assert.eq(
			(payload.equipment as string[]).length,
			2,
			"payload equipment list",
		);

		// ── Briefing summarises claim + notification counts ───────────────
		const brief = JSON.parse(r1.briefings[0].payload_json) as {
			equipment_claim_summary: { ok: boolean; claim_count: number; conflict_count: number };
			notification_count: number;
		};
		ctx.assert.eq(brief.equipment_claim_summary.ok, true, "claim summary ok");
		ctx.assert.eq(brief.equipment_claim_summary.claim_count, 2, "claim summary count");
		ctx.assert.eq(brief.notification_count, 2, "briefing notification count");

		ctx.notes.push(`cook_window claims=${r1.equipment_claim!.claims.length} notifications=${r1.notifications.length}`);
		ctx.notes.push(`conflict count on overlap: ${r2.equipment_claim!.conflicts.length}`);
	},
};

class FakeStmt {
	bind(..._v: unknown[]): this { void _v; return this; }
	async run() { return { success: true }; }
	async all<T = unknown>(): Promise<{ results: T[] }> { return { results: [] }; }
	async first<T = unknown>(): Promise<T | null> { return null; }
}

// Tagged-template SQL sink that supports the few SQL patterns the
// equipment-stub uses (CREATE TABLE / CREATE INDEX / INSERT / SELECT ...
// WHERE equipment = ? AND released_at_ms IS NULL ...).
function makeFakeSqlSink(): AgentSqlSink {
	const tables = new Map<string, Array<Record<string, unknown>>>();

	function exec(strings: TemplateStringsArray, ...values: unknown[]): unknown[] {
		const raw = strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i}` : ""), "").trim();

		if (/CREATE TABLE/i.test(raw)) {
			const m = raw.match(/CREATE TABLE IF NOT EXISTS\s+(\w+)/i);
			if (m && !tables.has(m[1])) tables.set(m[1], []);
			return [];
		}
		if (/^CREATE INDEX/i.test(raw)) return [];

		// INSERT INTO mise_equipment_claims_stub
		const insertM = raw.match(/INSERT INTO\s+(\w+)\s*\(([^)]+)\)/i);
		if (insertM) {
			const name = insertM[1];
			const cols = insertM[2].split(",").map(c => c.trim());
			if (!tables.has(name)) tables.set(name, []);
			const row: Record<string, unknown> = {};
			cols.forEach((col, i) => { row[col] = values[i]; });
			tables.get(name)!.push(row);
			return [];
		}

		// SELECT ... FROM mise_equipment_claims_stub WHERE equipment = $0 AND released_at_ms IS NULL AND start_ms < $1 AND end_ms > $2
		if (/^SELECT/i.test(raw)) {
			const fromM = raw.match(/FROM\s+(\w+)/i);
			if (!fromM) return [];
			const rows = tables.get(fromM[1]) || [];

			// Equipment overlap query.
			if (/equipment\s*=\s*\$0/.test(raw) && /start_ms\s*<\s*\$1/.test(raw) && /end_ms\s*>\s*\$2/.test(raw)) {
				const equipment = values[0];
				const queryEnd = values[1] as number;
				const queryStart = values[2] as number;
				return rows.filter(r => {
					if (r.equipment !== equipment) return false;
					if (r.released_at_ms !== null && r.released_at_ms !== undefined) return false;
					return (r.start_ms as number) < queryEnd && (r.end_ms as number) > queryStart;
				});
			}

			// COUNT(*) query for releaseEquipmentForMeal — return 0.
			if (/COUNT\(\*\)/i.test(raw)) {
				return [{ n: 0 }];
			}

			// Default: return all rows.
			return rows.slice();
		}

		// UPDATE — supports release.
		if (/^UPDATE/i.test(raw)) {
			return [];
		}

		return [];
	}

	return {
		sql: <T = Record<string, unknown>>(
			strings: TemplateStringsArray,
			...values: (string | number | boolean | null)[]
		): T[] => exec(strings, ...values) as T[],
	};
}

export default u43;
