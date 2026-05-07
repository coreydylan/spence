// U49 — CookAgent state-machine: extended phase enum + alarm timing +
// finish-feedback persistence.

import type { Scenario } from "../lib/types";
import { createMockD1 } from "../lib/mock-d1";
import {
	COOK_PHASES_EXT,
	COOK_TRANSITIONS_EXT,
	decideCookEntry,
	isLegalCookTransition,
	preSessionAlarmAt,
	recordCookFinish,
} from "../../src/mise-graph/agents/cook-phase-handlers";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

const u49: Scenario = {
	id: "u49",
	name: "CookAgent: extended state machine + pre_session alarm + cook-finish feedback row",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// ── 1. Extended phase enum has 5 entries inc. cancelled ────────────
		ctx.assert.eq(COOK_PHASES_EXT.length, 5, "extended cook enum has 5 phases");
		ctx.assert.contains(COOK_PHASES_EXT, "cancelled", "extended enum includes cancelled");

		// ── 2. Forward path is legal ───────────────────────────────────────
		const forward: Array<[string, string]> = [
			["planned", "pre_session"],
			["pre_session", "active_session"],
			["active_session", "completed"],
		];
		for (const [from, to] of forward) {
			ctx.assert.ok(
				isLegalCookTransition(from as never, to as never),
				`forward: ${from} → ${to}`,
			);
		}

		// ── 3. All non-terminals can transition to cancelled ──────────────
		for (const phase of ["planned", "pre_session", "active_session"] as const) {
			ctx.assert.ok(
				isLegalCookTransition(phase, "cancelled"),
				`${phase} → cancelled legal`,
			);
		}

		// ── 4. Terminal phases are terminal ────────────────────────────────
		for (const term of ["completed", "cancelled"] as const) {
			for (const next of COOK_PHASES_EXT) {
				ctx.assert.ok(
					!isLegalCookTransition(term, next),
					`${term} terminal: ${term} → ${next} illegal`,
				);
			}
		}

		// ── 5. Self-transitions illegal ────────────────────────────────────
		for (const phase of COOK_PHASES_EXT) {
			ctx.assert.ok(
				!isLegalCookTransition(phase, phase),
				`self-transition ${phase} → ${phase} illegal`,
			);
		}

		// ── 6. Skipping illegal ────────────────────────────────────────────
		ctx.assert.ok(
			!isLegalCookTransition("planned", "active_session"),
			"planned → active_session: skips pre_session",
		);

		// ── 7. preSessionAlarmAt: cook_window_start - 30min ────────────────
		const now = new Date("2026-05-13T12:00:00Z");
		const startIso = "2026-05-13T18:00:00Z";
		const alarm = preSessionAlarmAt(startIso, now);
		ctx.assert.ok(!!alarm, "alarm computed for future cook window");
		ctx.assert.eq(
			alarm!.toISOString(),
			"2026-05-13T17:30:00.000Z",
			"alarm fires 30min before cook_window_start",
		);

		// Past start → catch-up
		const pastAlarm = preSessionAlarmAt("2026-05-13T10:00:00Z", now);
		ctx.assert.ok(!!pastAlarm, "alarm computed for past start (catch-up)");
		ctx.assert.gt(pastAlarm!.getTime() - now.getTime(), 0, "catch-up alarm is in the future");
		ctx.assert.lte(pastAlarm!.getTime() - now.getTime(), 120_000, "catch-up alarm fires ~immediately");

		ctx.assert.eq(preSessionAlarmAt(null, now), null, "null start returns null");
		ctx.assert.eq(preSessionAlarmAt("not-iso", now), null, "invalid start returns null");

		// ── 8. decideCookEntry ─────────────────────────────────────────────
		const planned = decideCookEntry("planned", startIso, now);
		ctx.assert.eq(planned.side_effect_kind, "schedule_pre_session", "planned schedules pre_session");
		ctx.assert.ok(!!planned.next_alarm_at, "planned: alarm scheduled");
		const pre = decideCookEntry("pre_session", startIso, now);
		ctx.assert.eq(pre.side_effect_kind, "manual_only", "pre_session: manual only");
		ctx.assert.eq(pre.next_alarm_at, null, "pre_session: no alarm");
		const active = decideCookEntry("active_session", startIso, now);
		ctx.assert.eq(active.side_effect_kind, "manual_only", "active_session: manual only");
		const done = decideCookEntry("completed", startIso, now);
		ctx.assert.eq(done.side_effect_kind, "completion", "completed: completion");
		const cancelled = decideCookEntry("cancelled", startIso, now);
		ctx.assert.eq(cancelled.side_effect_kind, "cancellation", "cancelled: cancellation");

		// ── 9. recordCookFinish writes a feedback row ──────────────────────
		const db = createMockD1();
		const env = { DB: db as unknown as D1Database } as MiseGraphEnv;
		// mise_meal_feedback uses INSERT OR REPLACE so we just create the table.
		await env.DB.prepare(
			`CREATE TABLE IF NOT EXISTS mise_meal_feedback (
				id TEXT PRIMARY KEY,
				household_id TEXT,
				plan_id TEXT,
				meal_id TEXT,
				meal_date TEXT,
				meal_slot TEXT,
				meal_title TEXT,
				meal_cuisine_json TEXT,
				meal_format TEXT,
				rating INTEGER,
				would_repeat INTEGER,
				finished INTEGER,
				notes TEXT,
				recorded_at TEXT,
				meta_json TEXT
			)`,
		).run();

		const result = await recordCookFinish(env, {
			cook_id: "cook_1",
			meal_id: "meal:p1:2026-05-13:dinner",
			household_id: "hh_a",
			plan_id: "p1",
			rating: 4,
			notes: "really nice broth",
			now: new Date("2026-05-13T19:30:00Z"),
		});
		ctx.assert.ok(!!result.feedback_id, "feedback_id returned");

		const feedbackRow = await env.DB.prepare(
			`SELECT meal_id, rating, finished, notes FROM mise_meal_feedback
			 WHERE meal_id = ? LIMIT 1`,
		).bind("meal:p1:2026-05-13:dinner").first<{
			meal_id: string;
			rating: number;
			finished: number;
			notes: string;
		}>();
		ctx.assert.ok(!!feedbackRow, "feedback row persisted");
		ctx.assert.eq(feedbackRow!.rating, 4, "rating round-trips");
		ctx.assert.eq(feedbackRow!.finished, 1, "finished=1 by default for cook_finish");
		ctx.assert.eq(feedbackRow!.notes, "really nice broth", "notes round-trip");

		ctx.notes.push(`COOK_PHASES_EXT: ${COOK_PHASES_EXT.join(" / ")}`);
		ctx.notes.push(
			`transitions: ${Object.entries(COOK_TRANSITIONS_EXT).map(([k, v]) => `${k}→[${v.join(",")}]`).join(" | ")}`,
		);
	},
};

export default u49;
