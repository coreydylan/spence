// U42 — MealAgent pre_eve entry handler.
//
// pre_eve_entry is a pure async function that takes a MealSnapshot + deps
// and returns a PhaseHandlerResult containing the briefing row to write
// and the timestamp the next alarm should fire.
//
// Contract locked by this scenario:
//   1. Briefing row is shaped correctly (kind=pre_eve, JSON payload parses,
//      includes weather/calendar/equipment_readiness fields).
//   2. next_alarm_at_ms = eat_window_start_ms - 12h (matches "start of meal date").
//   3. Weather fetch is best-effort — handler swallows errors and emits a
//      `weather_fetch_failed:` note but still produces the briefing.
//   4. When location is missing, weather is null (no fetch attempted).

import type { Scenario } from "../lib/types";
import type { MiseGraphEnv } from "../../src/mise-graph/types";
import {
	pre_eve_entry,
	defaultWindowsForSlot,
	type MealSnapshot,
	type PhaseHandlerDeps,
} from "../../src/mise-graph/agents/meal-phase-handlers";

const u42: Scenario = {
	id: "u42",
	name: "MealAgent pre_eve entry: briefing row + day_of alarm at eat-12h",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const date = "2026-05-13";
		const windows = defaultWindowsForSlot(date, "dinner");
		const now_ms = windows.eat_window_start_ms - 24 * 60 * 60 * 1000; // ~24h before eat

		const snapshot: MealSnapshot = {
			meal_id: "meal:p1:2026-05-13:dinner",
			plan_id: "p1",
			household_id: "hh_a",
			date,
			slot: "dinner",
			format: "skillet",
			cuisine: ["mediterranean"],
			recipe_id: "recipe:lemony_chicken",
			cook_window_start_ms: windows.cook_window_start_ms,
			cook_window_end_ms:   windows.cook_window_end_ms,
			eat_window_start_ms:  windows.eat_window_start_ms,
			eat_window_end_ms:    windows.eat_window_end_ms,
			equipment: ["12in skillet", "oven"],
		};

		const env = makeFakeEnv();

		// ── Case 1: no location supplied — weather should be null ─────────
		const deps1: PhaseHandlerDeps = {
			env: env as unknown as MiseGraphEnv,
			now_ms,
			adults: { adult_member_ids: ["m_corey", "m_sara"] },
		};
		const r1 = await pre_eve_entry(snapshot, deps1);
		ctx.assert.eq(r1.phase, "pre_eve", "phase=pre_eve");
		ctx.assert.eq(r1.briefings.length, 1, "exactly one briefing emitted");
		ctx.assert.eq(r1.briefings[0].kind, "pre_eve", "briefing kind=pre_eve");
		ctx.assert.eq(r1.briefings[0].meal_id, snapshot.meal_id, "briefing references meal");
		ctx.assert.eq(r1.briefings[0].plan_id, "p1", "briefing references plan");
		ctx.assert.eq(r1.briefings[0].household_id, "hh_a", "briefing references household");

		const payload1 = JSON.parse(r1.briefings[0].payload_json) as Record<string, unknown>;
		ctx.assert.eq(payload1.kind, "pre_eve", "payload kind=pre_eve");
		ctx.assert.eq(payload1.weather, null, "no location → weather=null");
		ctx.assert.eq(payload1.recipe_id, "recipe:lemony_chicken", "recipe_id round-trips");
		ctx.assert.ok(Array.isArray(payload1.equipment_readiness), "equipment_readiness is an array");
		const er = payload1.equipment_readiness as Array<{ equipment: string; ready: boolean }>;
		ctx.assert.eq(er.length, 2, "equipment_readiness has both items");
		ctx.assert.eq(er[0].ready, true, "stub equipment marked ready");

		// ── Alarm: eat_window_start_ms - 12h ──────────────────────────────
		const expected = snapshot.eat_window_start_ms - 12 * 60 * 60 * 1000;
		ctx.assert.eq(
			r1.next_alarm_at_ms,
			expected,
			"next_alarm_at_ms = eat_window_start_ms - 12h",
		);

		// ── Case 2: location supplied but fetch fails (network shim) ──────
		const deps2: PhaseHandlerDeps = {
			env: env as unknown as MiseGraphEnv,
			now_ms,
			location: { lat: 32.71, lng: -117.16, tz: "America/Los_Angeles", city: "San Diego" },
			adults: { adult_member_ids: ["m_corey"] },
		};
		// Patch globalThis.fetch for this test only.
		const origFetch = globalThis.fetch;
		globalThis.fetch = (() => Promise.reject(new Error("simulated_offline"))) as typeof fetch;
		let r2;
		try {
			r2 = await pre_eve_entry(snapshot, deps2);
		} finally {
			globalThis.fetch = origFetch;
		}
		ctx.assert.eq(r2.briefings.length, 1, "fetch failure still emits briefing");
		ctx.assert.ok(
			r2.notes.some(n => n.startsWith("weather_fetch_failed:")),
			"weather_fetch_failed note recorded",
		);
		const payload2 = JSON.parse(r2.briefings[0].payload_json) as Record<string, unknown>;
		ctx.assert.eq(payload2.weather, null, "weather=null when fetch fails");

		// ── Case 3: alarm clamping when eat_window already passed ─────────
		const past_now_ms = snapshot.eat_window_start_ms + 60 * 60 * 1000;
		const r3 = await pre_eve_entry(snapshot, {
			...deps1,
			now_ms: past_now_ms,
		});
		ctx.assert.gte(
			r3.next_alarm_at_ms || 0,
			past_now_ms,
			"alarm clamped to >= now when eat_window already passed",
		);

		ctx.notes.push(`pre_eve briefing payload bytes: ${r1.briefings[0].payload_json.length}`);
		ctx.notes.push(`alarm at ${new Date(expected).toISOString()}`);
	},
};

// Minimal fake D1 — pre_eve_entry only calls readCalendarWindows; if we
// stub the prepare/all chain to return empty, the handler resolves to
// `calendar=null` for that household (and emits no error). This lets the
// scenario run in <1s without spinning up the full test infrastructure.
function makeFakeEnv(): { DB: { prepare: (sql: string) => FakeStmt } } {
	return {
		DB: {
			prepare: () => new FakeStmt(),
		},
	};
}

class FakeStmt {
	bind(..._values: unknown[]): this { void _values; return this; }
	async run(): Promise<{ success: boolean }> { return { success: true }; }
	async all<T = unknown>(): Promise<{ results: T[] }> { return { results: [] }; }
	async first<T = unknown>(): Promise<T | null> { return null; }
}

export default u42;
