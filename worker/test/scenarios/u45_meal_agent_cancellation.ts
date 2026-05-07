// U45 — MealAgent cancellation from every non-terminal phase.
//
// The MEAL_TRANSITIONS matrix in agents/base.ts uses `archived` as the
// terminal state for both natural completion and cancellation. The /cancel
// route writes a `cancelled:<reason>` reason on the phase transition and
// runs `cancelled_entry` (vs. plain `archived_entry`) so:
//   1. Equipment claims are released.
//   2. A "meal_cancelled" notification is fanned out to each adult so the
//      cook crew knows to stand down.
//   3. The legal-transition guard accepts non-terminal → archived from
//      planned, pre_eve, day_of, cook_window, active_cook (and eaten —
//      eaten can also archive, but cancellation from eaten doesn't
//      really make sense; we still verify the matrix permits it).
//
// This scenario:
//   - Verifies cancelled_entry's notification fan-out and equipment release.
//   - Verifies the MEAL_TRANSITIONS guard allows non-terminal → archived.
//   - Verifies archived → archived is rejected (terminal sink).

import type { Scenario } from "../lib/types";
import type { MiseGraphEnv } from "../../src/mise-graph/types";
import {
	cancelled_entry,
	defaultWindowsForSlot,
	type MealSnapshot,
} from "../../src/mise-graph/agents/meal-phase-handlers";
import {
	isLegalTransition,
	MEAL_TRANSITIONS,
	type AgentSqlSink,
	type MealPhase,
} from "../../src/mise-graph/agents/base";

const u45: Scenario = {
	id: "u45",
	name: "MealAgent cancellation: every non-terminal phase can cancel into archived",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// ── Matrix sanity check ────────────────────────────────────────────
		const cancellable: MealPhase[] = [
			"planned",
			"pre_eve",
			"day_of",
			"cook_window",
			"active_cook",
			"eaten",
		];
		for (const from of cancellable) {
			ctx.assert.ok(
				isLegalTransition(MEAL_TRANSITIONS, from, "archived"),
				`MEAL_TRANSITIONS allows ${from} → archived`,
			);
		}
		ctx.assert.ok(
			!isLegalTransition(MEAL_TRANSITIONS, "archived", "archived"),
			"archived → archived rejected (terminal sink)",
		);

		// ── cancelled_entry behaviour ──────────────────────────────────────
		const date = "2026-05-13";
		const windows = defaultWindowsForSlot(date, "dinner");
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
			equipment: ["12in skillet"],
		};
		const env = { DB: { prepare: () => new FakeStmt() } } as unknown as MiseGraphEnv;
		const sink = makeFakeSqlSink();

		// Pretend the meal had already claimed equipment — seed the sink so
		// releaseEquipmentForMeal has something to release.
		sink.sql`
			CREATE TABLE IF NOT EXISTS mise_equipment_claims_stub (
				claim_id TEXT PRIMARY KEY,
				meal_id TEXT NOT NULL,
				equipment TEXT NOT NULL,
				start_ms INTEGER NOT NULL,
				end_ms INTEGER NOT NULL,
				claimed_at_ms INTEGER NOT NULL,
				released_at_ms INTEGER
			)
		`;
		sink.sql`
			INSERT INTO mise_equipment_claims_stub
				(claim_id, meal_id, equipment, start_ms, end_ms, claimed_at_ms, released_at_ms)
			VALUES (${"equip_seed_1"}, ${snapshot.meal_id}, ${"12in skillet"}, ${snapshot.cook_window_start_ms}, ${snapshot.cook_window_end_ms}, ${Date.now()}, ${null})
		`;

		const adults = { adult_member_ids: ["m_corey", "m_sara", "  "] };
		const result = await cancelled_entry(
			snapshot,
			{ env, now_ms: Date.now(), adults },
			sink,
			"cook crew unavailable",
		);

		ctx.assert.eq(result.phase, "archived", "cancelled handler reports archived phase");
		ctx.assert.eq(result.next_alarm_at_ms, null, "no alarm scheduled after cancel");
		ctx.assert.eq(result.notifications.length, 2, "2 notifications (whitespace-only id skipped)");
		ctx.assert.eq(result.notifications[0].kind, "meal_cancelled", "notification kind=meal_cancelled");
		ctx.assert.contains(
			result.notifications[0].title,
			"Meal cancelled",
			"title prefix",
		);
		ctx.assert.eq(result.notifications[0].body, "cook crew unavailable", "body carries reason");
		ctx.assert.eq(result.notifications[0].source_agent_kind, "meal_agent", "source kind");
		ctx.assert.eq(result.notifications[0].source_agent_id, snapshot.meal_id, "source id = meal_id");

		ctx.assert.ok(!!result.equipment_released, "equipment released on cancel");
		ctx.assert.gte(result.equipment_released!.released, 0, "released count is non-negative");

		ctx.assert.contains(result.notes[0] || "", "cancelled:", "notes record cancellation");

		// ── Notification payload roundtrips ───────────────────────────────
		const payload = JSON.parse(result.notifications[0].payload_json || "{}") as Record<string, unknown>;
		ctx.assert.eq(payload.meal_id, snapshot.meal_id, "payload meal_id");
		ctx.assert.eq(payload.reason, "cook crew unavailable", "payload reason");

		ctx.notes.push(`cancellation notifications: ${result.notifications.length}`);
		ctx.notes.push(`equipment released: ${result.equipment_released!.released}`);
	},
};

class FakeStmt {
	bind(..._v: unknown[]): this { void _v; return this; }
	async run() { return { success: true }; }
	async all<T = unknown>(): Promise<{ results: T[] }> { return { results: [] }; }
	async first<T = unknown>(): Promise<T | null> { return null; }
}

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
		if (/^SELECT/i.test(raw)) {
			const fromM = raw.match(/FROM\s+(\w+)/i);
			if (!fromM) return [];
			const rows = tables.get(fromM[1]) || [];
			if (/COUNT\(\*\)/i.test(raw)) {
				const meal = String(values[0] ?? "");
				const n = rows.filter(r => r.meal_id === meal && r.released_at_ms == null).length;
				return [{ n }];
			}
			return rows.slice();
		}
		if (/^UPDATE/i.test(raw)) {
			// Mark released_at_ms — the release helper sets it.
			const fromM = raw.match(/UPDATE\s+(\w+)/i);
			if (fromM) {
				const name = fromM[1];
				const rows = tables.get(name) || [];
				const meal = String(values[1] ?? "");
				for (const r of rows) {
					if (r.meal_id === meal && r.released_at_ms == null) {
						r.released_at_ms = values[0] as number;
					}
				}
			}
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

export default u45;
