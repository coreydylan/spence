// U83 — Track C: MealAgent pre_eve briefing surfaces calendar conflicts.
//
// When the night-before pre_eve handler runs, it now reads household
// calendar busy-blocks for the meal date and folds the conflict surface
// into the briefing payload:
//   - calendar_busy_blocks_json: blocks intersecting cook+eat windows
//   - cook_window_conflict / eat_window_conflict: 0/1 flags
//   - cook_window_tight: 0/1 — partial overlap leaves <half-window free
//   - conflict_summary: human-readable line ("no conflicts" / "6:00pm
//     Standup overlaps cook window")
// When any conflict exists the handler also fans out a `calendar_conflict`
// notification per adult so MemberAgent can ping the user the night before.
//
// Schema strategy: all conflict info goes into the briefing's payload_json
// (Option C — payload-only). The mise_meal_briefings table layout stays
// stable; readers parse JSON exactly the way day_of/cook_window readers do.

import type { Scenario } from "../lib/types";
import type { MiseGraphEnv } from "../../src/mise-graph/types";
import {
	pre_eve_entry,
	defaultWindowsForSlot,
	type MealSnapshot,
	type PhaseHandlerDeps,
} from "../../src/mise-graph/agents/meal-phase-handlers";

const u83: Scenario = {
	id: "u83",
	name: "MealAgent pre_eve: calendar conflicts surfaced + heads-up notification",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const date = "2026-05-13";
		const windows = defaultWindowsForSlot(date, "dinner");
		// dinner default: cook 17:00–18:30 (UTC anchor), eat 18:30–20:00
		const now_ms = windows.eat_window_start_ms - 24 * 60 * 60 * 1000;

		const snapshot: MealSnapshot = {
			meal_id: "meal:p1:2026-05-13:dinner",
			plan_id: "p1",
			household_id: "hh_a",
			date,
			slot: "dinner",
			format: "skillet",
			cuisine: ["italian"],
			recipe_id: "recipe:weeknight_pasta",
			cook_window_start_ms: windows.cook_window_start_ms,
			cook_window_end_ms:   windows.cook_window_end_ms,
			eat_window_start_ms:  windows.eat_window_start_ms,
			eat_window_end_ms:    windows.eat_window_end_ms,
			equipment: ["12in skillet"],
		};

		// ── Case 1: busy 17:30–18:30 — overlaps the back half of the
		//          cook window (17:00–18:30) AND the start of the eat
		//          window (18:30 boundary doesn't overlap, so eat=clean).
		const env1 = makeEnvWithCalendarBlocks([
			{
				start: `${date}T17:30`,
				end:   `${date}T18:30`,
				title: "Standup",
			},
		]);
		const deps1: PhaseHandlerDeps = {
			env: env1 as unknown as MiseGraphEnv,
			now_ms,
			adults: { adult_member_ids: ["m_corey", "m_sara"] },
		};
		const r1 = await pre_eve_entry(snapshot, deps1);

		ctx.assert.eq(r1.briefings.length, 1, "one briefing emitted");
		const payload = JSON.parse(r1.briefings[0].payload_json) as Record<string, unknown>;
		ctx.assert.eq(payload.cook_window_conflict, 1, "cook_window_conflict flagged");
		ctx.assert.ok(
			Array.isArray(payload.calendar_busy_blocks_json),
			"calendar_busy_blocks_json is an array",
		);
		const blocks = payload.calendar_busy_blocks_json as Array<{ title: string }>;
		ctx.assert.eq(blocks.length, 1, "one intersecting busy block recorded");
		ctx.assert.eq(blocks[0].title, "Standup", "block title preserved");
		ctx.assert.contains(
			(payload.conflict_summary as string) || "",
			"cook window",
			"summary mentions cook window",
		);

		// Conflict → one notification per adult, kind=calendar_conflict.
		ctx.assert.eq(r1.notifications.length, 2, "fan-out to two adults");
		ctx.assert.eq(r1.notifications[0].kind, "calendar_conflict", "notification kind");
		ctx.assert.eq(
			r1.notifications[0].source_agent_kind,
			"meal_agent",
			"source_agent_kind = meal_agent",
		);
		ctx.assert.eq(
			r1.notifications[0].source_agent_id,
			snapshot.meal_id,
			"source_agent_id = meal_id",
		);
		const notifPayload = JSON.parse(r1.notifications[0].payload_json || "{}") as Record<string, unknown>;
		ctx.assert.eq(notifPayload.cook_window_conflict, true, "notif payload conflict=true");

		// ── Case 2: no calendar blocks → "no conflicts", zero notifs.
		const env2 = makeEnvWithCalendarBlocks([]);
		const r2 = await pre_eve_entry(snapshot, {
			env: env2 as unknown as MiseGraphEnv,
			now_ms,
			adults: { adult_member_ids: ["m_corey"] },
		});
		const payload2 = JSON.parse(r2.briefings[0].payload_json) as Record<string, unknown>;
		ctx.assert.eq(payload2.cook_window_conflict, 0, "no cook conflict on clean cal");
		ctx.assert.eq(payload2.eat_window_conflict, 0, "no eat conflict on clean cal");
		ctx.assert.eq(payload2.conflict_summary, "no conflicts", "summary='no conflicts'");
		ctx.assert.eq(r2.notifications.length, 0, "no notifs when calendar clear");

		// ── Case 3: busy 19:00–19:30 — only overlaps eat window.
		const env3 = makeEnvWithCalendarBlocks([
			{ start: `${date}T19:00`, end: `${date}T19:30`, title: "Call" },
		]);
		const r3 = await pre_eve_entry(snapshot, {
			env: env3 as unknown as MiseGraphEnv,
			now_ms,
			adults: { adult_member_ids: ["m_corey"] },
		});
		const payload3 = JSON.parse(r3.briefings[0].payload_json) as Record<string, unknown>;
		ctx.assert.eq(payload3.cook_window_conflict, 0, "cook clean (19:00 > 18:30)");
		ctx.assert.eq(payload3.eat_window_conflict, 1, "eat conflict flagged");
		ctx.assert.eq(r3.notifications.length, 1, "eat-only conflict still notifies");

		ctx.notes.push(`pre_eve conflict summary: ${String(payload.conflict_summary)}`);
		ctx.notes.push(`busy blocks recorded: ${blocks.length}`);
	},
};

// Minimal D1 stub that returns scripted rows for the calendar-blocks
// SELECT query and no-ops everything else. Mirrors the u42 pattern but
// teaches `.all()` to return synthetic CalendarBlockRows.
function makeEnvWithCalendarBlocks(blocks: Array<{ start: string; end: string; title: string }>) {
	const rows = blocks.map((b, i) => ({
		block_id: `cal_${i}`,
		household_id: "hh_a",
		start_at: b.start,
		end_at: b.end,
		title: b.title,
		busy: 1,
		source: "manual",
		location: null,
		description: null,
		metadata_json: null,
	}));
	class Stmt {
		private sql: string;
		constructor(sql: string) { this.sql = sql; }
		bind(..._v: unknown[]): this { void _v; return this; }
		async run() { return { success: true }; }
		async all<T = unknown>(): Promise<{ results: T[] }> {
			if (/FROM\s+mise_calendar_blocks/i.test(this.sql)) {
				return { results: rows as unknown as T[] };
			}
			return { results: [] };
		}
		async first<T = unknown>(): Promise<T | null> { return null; }
	}
	return {
		DB: {
			prepare: (sql: string) => new Stmt(sql),
		},
	};
}

export default u83;
