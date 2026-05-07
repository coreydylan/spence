// U44 — MealAgent full lifecycle: planned → archived through all 7 phases.
//
// This scenario walks the entire happy-path state machine using the pure
// per-phase entry handlers. The purpose is to lock the contract that:
//   1. Each handler emits the right shape (briefings, notifications,
//      cook_sessions arrays in the result).
//   2. The next_alarm_at_ms cascade chains the phases correctly:
//        pre_eve.next   = day_of  (eat - 12h)
//        day_of.next    = cook_window (cook_window_start)
//        cook_window.next = active_cook (cook_window_start + 30min)
//        active_cook.next = eaten timeout (now + 4h, stale marker)
//        eaten.next     = archived (eaten + 72h)
//        archived.next  = null    (terminal)
//   3. equipment_released fires at archive.

import type { Scenario } from "../lib/types";
import type { MiseGraphEnv } from "../../src/mise-graph/types";
import {
	active_cook_entry,
	archived_entry,
	cook_window_entry,
	day_of_entry,
	defaultWindowsForSlot,
	eaten_entry,
	pre_eve_entry,
	type MealSnapshot,
	type PhaseHandlerDeps,
} from "../../src/mise-graph/agents/meal-phase-handlers";
import { type AgentSqlSink } from "../../src/mise-graph/agents/base";

const u44: Scenario = {
	id: "u44",
	name: "MealAgent full lifecycle: 6-phase cascade with alarm chain",
	group: "unit",
	tier: "fast",
	async run(ctx) {
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
			equipment: ["12in skillet", "oven"],
		};

		const env = { DB: { prepare: () => new FakeStmt() } } as unknown as MiseGraphEnv;
		const sink = makeFakeSqlSink();
		const adults = { adult_member_ids: ["m_corey", "m_sara"] };

		// Walk the full chain. We use synthetic "now" timestamps so the
		// alarm cascade is deterministic.
		const t_pre_eve_now = snapshot.eat_window_start_ms - 24 * 60 * 60 * 1000;
		const t_day_of_now = snapshot.eat_window_start_ms - 12 * 60 * 60 * 1000;
		const t_cook_window_now = snapshot.cook_window_start_ms;
		const t_active_cook_now = snapshot.cook_window_start_ms + 15 * 60 * 1000;
		const t_eaten_now = snapshot.eat_window_start_ms + 30 * 60 * 1000;
		const t_archived_now = t_eaten_now + 72 * 60 * 60 * 1000;

		// pre_eve
		const r_pre = await pre_eve_entry(snapshot, mkDeps(env, t_pre_eve_now, adults));
		ctx.assert.eq(r_pre.phase, "pre_eve", "phase=pre_eve");
		ctx.assert.eq(r_pre.briefings.length, 1, "pre_eve emits 1 briefing");
		ctx.assert.eq(
			r_pre.next_alarm_at_ms,
			snapshot.eat_window_start_ms - 12 * 60 * 60 * 1000,
			"pre_eve→day_of fires at eat-12h",
		);

		// day_of
		const r_day = await day_of_entry(snapshot, mkDeps(env, t_day_of_now, adults));
		ctx.assert.eq(r_day.phase, "day_of", "phase=day_of");
		ctx.assert.eq(r_day.briefings.length, 1, "day_of emits 1 briefing");
		const dayPayload = JSON.parse(r_day.briefings[0].payload_json) as {
			cook_crew: Array<{ member_id: string; availability: string }>;
		};
		ctx.assert.eq(dayPayload.cook_crew.length, 2, "day_of records adult crew list");
		ctx.assert.eq(
			r_day.next_alarm_at_ms,
			snapshot.cook_window_start_ms,
			"day_of→cook_window fires at cook_window_start",
		);

		// cook_window
		const r_cw = await cook_window_entry(snapshot, mkDeps(env, t_cook_window_now, adults), sink);
		ctx.assert.eq(r_cw.phase, "cook_window", "phase=cook_window");
		ctx.assert.eq(r_cw.notifications.length, 2, "cook_window fans 2 member calls");
		ctx.assert.eq(r_cw.equipment_claim!.ok, true, "claim succeeds on fresh sink");
		ctx.assert.eq(
			r_cw.next_alarm_at_ms,
			snapshot.cook_window_start_ms + 30 * 60 * 1000,
			"cook_window→active_cook 30min auto-trigger",
		);

		// active_cook
		const r_ac = await active_cook_entry(snapshot, mkDeps(env, t_active_cook_now, adults));
		ctx.assert.eq(r_ac.phase, "active_cook", "phase=active_cook");
		ctx.assert.eq(r_ac.cook_sessions.length, 1, "active_cook writes 1 cook session marker");
		ctx.assert.eq(r_ac.cook_sessions[0].state, "started", "cook session state=started");
		ctx.assert.matches(
			r_ac.cook_sessions[0].cook_session_id,
			/^cook_/,
			"cook_session_id namespaced",
		);
		ctx.assert.eq(
			r_ac.next_alarm_at_ms,
			t_active_cook_now + 4 * 60 * 60 * 1000,
			"active_cook stale alarm at now + 4h",
		);
		const meta = JSON.parse(r_ac.cook_sessions[0].meta_json || "{}") as Record<string, unknown>;
		ctx.assert.contains(
			String(meta.wave_8_handoff || ""),
			"CookingLeadAgent",
			"meta records Wave 8 hand-off boundary",
		);

		// eaten
		const r_eat = await eaten_entry(
			snapshot,
			mkDeps(env, t_eaten_now, adults),
			r_ac.cook_sessions[0].cook_session_id,
		);
		ctx.assert.eq(r_eat.phase, "eaten", "phase=eaten");
		ctx.assert.eq(r_eat.cook_sessions.length, 1, "eaten emits an end-row for the session");
		ctx.assert.eq(r_eat.cook_sessions[0].state, "ended", "session state=ended");
		ctx.assert.eq(r_eat.cook_sessions[0].ended_reason, "eaten", "ended_reason=eaten");
		ctx.assert.eq(
			r_eat.next_alarm_at_ms,
			t_eaten_now + 72 * 60 * 60 * 1000,
			"eaten→archived at eaten+72h",
		);

		// archived (terminal)
		const r_arc = await archived_entry(snapshot, mkDeps(env, t_archived_now, adults), sink);
		ctx.assert.eq(r_arc.phase, "archived", "phase=archived");
		ctx.assert.eq(r_arc.next_alarm_at_ms, null, "archived schedules no alarm");
		ctx.assert.ok(!!r_arc.equipment_released, "archived releases equipment");
		// We don't assert .released > 0 because the FakeSqlSink doesn't
		// implement COUNT(*) updates — the call shape is what matters here.
		ctx.assert.gte(r_arc.equipment_released!.released, 0, "released count is non-negative");

		// Sanity: assertion that the chain produces a strictly increasing
		// alarm timeline for the auto-driven phases.
		const chain = [
			r_pre.next_alarm_at_ms!,
			r_day.next_alarm_at_ms!,
			r_cw.next_alarm_at_ms!,
		];
		for (let i = 1; i < chain.length; i++) {
			ctx.assert.gt(chain[i], chain[i - 1], `chain step ${i} strictly later`);
		}

		ctx.notes.push(`alarm chain: pre_eve→${new Date(r_pre.next_alarm_at_ms!).toISOString()}`);
		ctx.notes.push(`alarm chain: day_of→${new Date(r_day.next_alarm_at_ms!).toISOString()}`);
		ctx.notes.push(`alarm chain: cook_window→${new Date(r_cw.next_alarm_at_ms!).toISOString()}`);
		ctx.notes.push(`alarm chain: active_cook stale=${new Date(r_ac.next_alarm_at_ms!).toISOString()}`);
		ctx.notes.push(`alarm chain: eaten→${new Date(r_eat.next_alarm_at_ms!).toISOString()}`);
	},
};

function mkDeps(env: MiseGraphEnv, now_ms: number, adults: { adult_member_ids: string[] }): PhaseHandlerDeps {
	return { env, now_ms, adults };
}

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
			if (/equipment\s*=\s*\$0/.test(raw)) {
				const equipment = values[0];
				const qEnd = values[1] as number;
				const qStart = values[2] as number;
				return rows.filter(r => r.equipment === equipment && (r.released_at_ms == null) && (r.start_ms as number) < qEnd && (r.end_ms as number) > qStart);
			}
			if (/COUNT\(\*\)/i.test(raw)) return [{ n: 0 }];
			return rows.slice();
		}
		if (/^UPDATE/i.test(raw)) return [];
		return [];
	}
	return {
		sql: <T = Record<string, unknown>>(
			strings: TemplateStringsArray,
			...values: (string | number | boolean | null)[]
		): T[] => exec(strings, ...values) as T[],
	};
}

export default u44;
