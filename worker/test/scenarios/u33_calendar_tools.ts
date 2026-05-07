// U33 — Calendar tools: read busy blocks → cook/eat/shop windows; stage,
// list, and cancel events.
//
// Uses the shared mock-d1. Adds synthetic blocks via addCalendarBlock and
// asserts the longest free afternoon block is correctly identified.
// Stages 3 events, lists them (filtered + unfiltered), cancels one, and
// verifies status flips to "canceled".

import type { Scenario } from "../lib/types";
import { createMockD1 } from "../lib/mock-d1";
import {
	addCalendarBlock,
	cancelStagedEvent,
	listStagedEvents,
	migrateCalendarSchema,
	readCalendarWindows,
	stageCalendarEvent,
} from "../../src/mise-graph/calendar-tools";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

const u33: Scenario = {
	id: "u33",
	name: "Calendar tools: cook/eat/shop windows + stage/list/cancel events",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const db = createMockD1();
		const env = { DB: db as unknown as D1Database } as MiseGraphEnv;
		await migrateCalendarSchema(env);

		const HH = "hh_cal_test";

		// ── Synthetic week: Mon 5/11 (kid practice 6-8pm), Sat 5/16 (open) ──
		// Mon — practice 18:00-20:00 (eats into eat_window)
		await addCalendarBlock(env, HH, {
			start: "2026-05-11T18:00",
			end: "2026-05-11T20:00",
			title: "kid soccer practice",
			busy: true,
			source: "manual",
		});
		// Mon — work meeting 14:00-15:30 (eats into cook_window early)
		await addCalendarBlock(env, HH, {
			start: "2026-05-11T14:00",
			end: "2026-05-11T15:30",
			title: "team standup",
			busy: true,
			source: "google",
		});
		// Tue — fully open day
		// Wed — date night 18:30-22:00 (no home meal possible)
		await addCalendarBlock(env, HH, {
			start: "2026-05-13T18:30",
			end: "2026-05-13T22:00",
			title: "date night",
			busy: true,
			source: "manual",
		});
		// Sat — kid game 09:00-11:30 (eats into shop_window)
		await addCalendarBlock(env, HH, {
			start: "2026-05-16T09:00",
			end: "2026-05-16T11:30",
			title: "kid game",
			busy: true,
		});

		const windows = await readCalendarWindows(env, HH, "2026-05-11", "2026-05-16");
		ctx.assert.eq(windows.length, 6, "6 days returned (Mon-Sat)");
		ctx.assert.eq(windows[0].date, "2026-05-11", "first day is Mon");
		ctx.assert.eq(windows[5].date, "2026-05-16", "last day is Sat");

		// Mon: cook_window should be the longest free 30+ block in 14-21h.
		// Busy on Mon: 14:00-15:30, 18:00-20:00 → free slices in window 14-21:
		//   15:30-18:00 (150 min)  ← winner
		//   20:00-21:00 (60 min)
		const mon = windows[0];
		ctx.assert.eq(mon.busy_blocks.length, 2, "Mon has 2 busy blocks");
		ctx.assert.ok(!!mon.cook_window, "Mon has a cook_window");
		ctx.assert.eq(mon.cook_window?.start, "2026-05-11T15:30", "Mon cook_window starts at 15:30");
		ctx.assert.eq(mon.cook_window?.end, "2026-05-11T18:00", "Mon cook_window ends at 18:00 (before practice)");
		ctx.assert.eq(mon.cook_window?.duration_min, 150, "Mon cook_window = 150 min");
		// Mon eat_window: 18:30-20:00 fully overlapped by practice → no slot meets 20-min minimum.
		ctx.assert.ok(!mon.eat_window, "Mon eat_window is unavailable (practice overlaps dinner)");

		// Tue: fully open → cook_window should fill the entire 14-21h band.
		const tue = windows[1];
		ctx.assert.eq(tue.date, "2026-05-12", "Tue is 5/12");
		ctx.assert.eq(tue.busy_blocks.length, 0, "Tue is open");
		ctx.assert.ok(!!tue.cook_window, "Tue has a cook_window");
		ctx.assert.eq(tue.cook_window?.start, "2026-05-12T14:00", "Tue cook_window starts at 14:00");
		ctx.assert.eq(tue.cook_window?.end, "2026-05-12T21:00", "Tue cook_window ends at 21:00");
		ctx.assert.eq(tue.cook_window?.duration_min, 7 * 60, "Tue cook_window = 7 hours");
		ctx.assert.ok(!!tue.eat_window, "Tue has eat_window 18:30-20:00");

		// Wed: date night blocks dinner; cook_window should still find afternoon prep (14-18:30).
		const wed = windows[2];
		ctx.assert.eq(wed.date, "2026-05-13", "Wed is 5/13");
		ctx.assert.eq(wed.cook_window?.end, "2026-05-13T18:30", "Wed cook_window ends at date-night start");
		ctx.assert.ok(!wed.eat_window, "Wed has no eat_window (date night)");

		// Sat: shop_window window is 08:00-12:00 (weekend). Game blocks 9-11:30,
		// leaving free slices 8-9 (60 min) and 11:30-12 (30 min). The longer
		// pre-game slice wins — the agent can shop early.
		const sat = windows[5];
		ctx.assert.eq(sat.date, "2026-05-16", "Sat is 5/16");
		ctx.assert.ok(!!sat.shop_window, "Sat has a shop_window");
		ctx.assert.eq(sat.shop_window?.start, "2026-05-16T08:00", "Sat shop_window starts at 8 (longest pre-game slice)");
		ctx.assert.eq(sat.shop_window?.end, "2026-05-16T09:00", "Sat shop_window ends when game starts");
		ctx.assert.eq(sat.shop_window?.duration_min, 60, "Sat shop_window = 60 min (longer than 30-min post-game slice)");

		ctx.notes.push(`mon cook_window=${mon.cook_window?.duration_min}m`);
		ctx.notes.push(`tue cook_window=${tue.cook_window?.duration_min}m`);
		ctx.notes.push(`sat shop_window=${sat.shop_window?.duration_min}m`);

		// ── Stage 3 events ──────────────────────────────────────────────────
		const e1 = await stageCalendarEvent(env, HH, {
			start: "2026-05-12T17:30",
			end: "2026-05-12T19:30",
			title: "Cook: Tuscan ribollita",
			description: "60 min total, 20 active",
			metadata: { plan_id: "plan_A", entity_id: "meal:tue_dinner", entity_type: "meal" },
		});
		const e2 = await stageCalendarEvent(env, HH, {
			start: "2026-05-12T16:30",
			end: "2026-05-12T17:00",
			title: "Prep: soak beans",
			metadata: { plan_id: "plan_A", entity_id: "cook:soak_beans", entity_type: "cook" },
		});
		const e3 = await stageCalendarEvent(env, HH, {
			start: "2026-05-16T11:30",
			end: "2026-05-16T12:30",
			title: "Shop: weekly groceries",
			location: "Trader Joe's",
			metadata: { plan_id: "plan_A", entity_id: "shop:weekly", entity_type: "shop" },
		});
		ctx.assert.ok(e1.event_id.length > 0, "stageCalendarEvent returns event_id");
		ctx.assert.ok(e2.event_id !== e1.event_id, "event_ids are unique");

		const allEvents = await listStagedEvents(env, HH);
		ctx.assert.eq(allEvents.length, 3, "list returns all 3 staged events");
		ctx.assert.ok(allEvents.every(e => e.status === "staged"), "all start in 'staged' status");
		// Order should be by start_at ASC.
		ctx.assert.eq(allEvents[0].start, "2026-05-12T16:30", "earliest event sorts first");
		ctx.assert.eq(allEvents[2].start, "2026-05-16T11:30", "latest event sorts last");

		const planAEvents = await listStagedEvents(env, HH, "plan_A");
		ctx.assert.eq(planAEvents.length, 3, "plan_A scope returns all 3");
		const planBEvents = await listStagedEvents(env, HH, "plan_other");
		ctx.assert.eq(planBEvents.length, 0, "unknown plan returns empty");

		// Metadata round-trip.
		const ribollita = allEvents.find(e => e.title.includes("ribollita"));
		ctx.assert.ok(!!ribollita, "ribollita event found");
		ctx.assert.eq(ribollita?.metadata.entity_type, "meal", "metadata.entity_type preserved");
		ctx.assert.eq(ribollita?.metadata.entity_id, "meal:tue_dinner", "metadata.entity_id preserved");

		// ── Cancel one, verify flip ─────────────────────────────────────────
		await cancelStagedEvent(env, e2.event_id);
		const afterCancel = await listStagedEvents(env, HH);
		ctx.assert.eq(afterCancel.length, 3, "canceled event still listed (status filter is caller's job)");
		const canceled = afterCancel.find(e => e.event_id === e2.event_id);
		ctx.assert.eq(canceled?.status, "canceled", "canceled event has status='canceled'");
		const stillStaged = afterCancel.filter(e => e.status === "staged");
		ctx.assert.eq(stillStaged.length, 2, "2 events remain staged");

		// Bad input rejection.
		let threw = false;
		try {
			await stageCalendarEvent(env, HH, {
				start: "not-a-time",
				end: "2026-05-16T12:30",
				title: "bogus",
				metadata: { plan_id: "p", entity_id: "e", entity_type: "meal" },
			});
		} catch {
			threw = true;
		}
		ctx.assert.eq(threw, true, "stageCalendarEvent rejects invalid start");

		// readCalendarWindows on empty range returns []
		const empty = await readCalendarWindows(env, HH, "not-a-date", "2026-01-01");
		ctx.assert.eq(empty.length, 0, "invalid start_date → empty windows");
	},
};

export default u33;
