// U82 — Track B: people-aware cook window adjustments.
//
// `adjustWindowsForPeopleAndCook` is a pure function used by
// MealAgent.handleInit to shift `cook_window_start_ms` based on:
//   - guest count (>2 → earlier; 1 → later; capped at 60 min earlier)
//   - active-cook estimate (>60 min → earlier by the surplus)
// The two shifts compose. cook_window_end / eat_window_* never move —
// only the start of cooking does, since the meal time itself is
// anchored to the household's social-clock.
//
// Contract these tests pin down:
//   1. 2 people, donburi (35 min cook): no shift → 17:00 start
//   2. 4 people, donburi: (4-2)*10=20 min earlier → 16:40
//   3. 1 person, donburi: solo +15 min later → 17:15
//   4. 4 people, mezze (60 min cook, NOT >60): only people shift → 16:40
//   5. 6 people: (6-2)*10=40 min earlier (within the 60 min cap) → 16:20
//      AND a 10-person check that the cap actually kicks in at 60 min.

import type { Scenario } from "../lib/types";
import {
	adjustWindowsForPeopleAndCook,
	defaultWindowsForSlot,
} from "../../src/mise-graph/agents/meal-phase-handlers";

// Format → active-cook minutes (mirrors the FORMAT_COOK_MIN map in
// meal-agent.ts; keeping it inline here keeps the test pure).
const COOK_MIN_DONBURI = 35;
const COOK_MIN_MEZZE   = 60;
const COOK_MIN_TAGINE  = 70;

const u82: Scenario = {
	id: "u82",
	name: "MealAgent people-aware cook window adjustment (Track B)",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const date = "2026-05-13";
		const base = defaultWindowsForSlot(date, "dinner");
		const baseStart = base.cook_window_start_ms; // 17:00 local-clock

		// ── Test 1: 2 people, donburi → unchanged 17:00 start ───────────
		const r1 = adjustWindowsForPeopleAndCook(base, 2, COOK_MIN_DONBURI);
		ctx.assert.eq(
			r1.cook_window_start_ms,
			baseStart,
			"2 people + donburi: cook_window_start unchanged at 17:00",
		);
		ctx.assert.eq(
			r1.cook_window_end_ms,
			base.cook_window_end_ms,
			"cook_window_end never moves",
		);
		ctx.assert.eq(
			r1.eat_window_start_ms,
			base.eat_window_start_ms,
			"eat_window_start never moves",
		);
		ctx.assert.eq(
			r1.eat_window_end_ms,
			base.eat_window_end_ms,
			"eat_window_end never moves",
		);

		// ── Test 2: 4 people, donburi → 20 min earlier (16:40) ──────────
		const r2 = adjustWindowsForPeopleAndCook(base, 4, COOK_MIN_DONBURI);
		ctx.assert.eq(
			r2.cook_window_start_ms,
			baseStart - 20 * 60_000,
			"4 people + donburi: cook_window_start shifts 20 min earlier (16:40)",
		);
		ctx.assert.eq(
			r2.cook_window_end_ms,
			base.cook_window_end_ms,
			"4 people: cook_window_end unchanged",
		);

		// ── Test 3: 1 person, donburi → 15 min later (17:15) ────────────
		const r3 = adjustWindowsForPeopleAndCook(base, 1, COOK_MIN_DONBURI);
		ctx.assert.eq(
			r3.cook_window_start_ms,
			baseStart + 15 * 60_000,
			"1 person + donburi: cook_window_start shifts 15 min later (17:15)",
		);

		// ── Test 4: 4 people, mezze (cook_active_min=60) → 16:40 ────────
		// Mezze is exactly 60 min, NOT >60, so no extra shift from the
		// long-prep rule — only the (4-2)*10=20 min people shift applies.
		const r4 = adjustWindowsForPeopleAndCook(base, 4, COOK_MIN_MEZZE);
		ctx.assert.eq(
			r4.cook_window_start_ms,
			baseStart - 20 * 60_000,
			"4 people + mezze (60 min): cook_window_start at 16:40 (only people shift)",
		);

		// ── Test 5a: 6 people → 40 min earlier (16:20), under the cap ───
		const r5a = adjustWindowsForPeopleAndCook(base, 6, COOK_MIN_DONBURI);
		ctx.assert.eq(
			r5a.cook_window_start_ms,
			baseStart - 40 * 60_000,
			"6 people: 40 min earlier (16:20), within the 60-min cap",
		);
		// Verify the people-shift never exceeds the 60-min cap.
		const peopleShift5aMin = (baseStart - r5a.cook_window_start_ms) / 60_000;
		ctx.assert.lte(peopleShift5aMin, 60, "people shift ≤ 60 min cap");

		// ── Test 5b: 10 people → cap kicks in at 60 min earlier (16:00) ─
		const r5b = adjustWindowsForPeopleAndCook(base, 10, COOK_MIN_DONBURI);
		ctx.assert.eq(
			r5b.cook_window_start_ms,
			baseStart - 60 * 60_000,
			"10 people: capped at 60 min earlier (16:00)",
		);

		// ── Bonus: composition — 4 people + tagine (70 min cook) ───────
		// people shift 20 min + cook-active surplus 10 min = 30 min earlier.
		const rCompose = adjustWindowsForPeopleAndCook(base, 4, COOK_MIN_TAGINE);
		ctx.assert.eq(
			rCompose.cook_window_start_ms,
			baseStart - 30 * 60_000,
			"4 people + tagine: 20 (people) + 10 (cook surplus) = 30 min earlier",
		);

		// ── Edge: nullish people / cook_active_min are no-ops ──────────
		const rNull = adjustWindowsForPeopleAndCook(base, null, null);
		ctx.assert.eq(
			rNull.cook_window_start_ms,
			baseStart,
			"null people + null cook_active_min: no shift",
		);

		ctx.notes.push(
			`shifts: 2p=${(baseStart - r1.cook_window_start_ms) / 60_000}min, ` +
			`4p=${(baseStart - r2.cook_window_start_ms) / 60_000}min, ` +
			`1p=${(baseStart - r3.cook_window_start_ms) / 60_000}min, ` +
			`6p=${(baseStart - r5a.cook_window_start_ms) / 60_000}min, ` +
			`10p(cap)=${(baseStart - r5b.cook_window_start_ms) / 60_000}min, ` +
			`4p+tagine=${(baseStart - rCompose.cook_window_start_ms) / 60_000}min`,
		);
	},
};

export default u82;
