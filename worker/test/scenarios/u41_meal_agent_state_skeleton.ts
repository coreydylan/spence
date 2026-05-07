// U41 — MealAgent state-machine skeleton.
//
// Locks the canonical phase set + transition matrix for MealAgent. The Wave
// 7 foundation contract is:
//   * 7 phases in this order: planned, pre_eve, day_of, cook_window,
//     active_cook, eaten, archived.
//   * Forward path: planned → pre_eve → day_of → cook_window → active_cook
//     → eaten → archived.
//   * Every non-terminal phase can transition to `archived` (cancellation).
//   * `archived` is terminal (no outbound transitions).
//   * Some backward steps are legal (Wave 7B uses these for cancellation /
//     "actually we're prepping tomorrow not today" corrections):
//       pre_eve → planned, day_of → pre_eve, cook_window → day_of,
//       active_cook → cook_window.
//
// If Wave 7B needs to widen the matrix it must update this test alongside
// the change so the contract stays explicit.

import type { Scenario } from "../lib/types";
import {
	COOK_PHASES,
	COOK_TRANSITIONS,
	isLegalTransition,
	MEAL_PHASES,
	MEAL_TRANSITIONS,
	type MealPhase,
	SHOP_PHASES,
	SHOP_TRANSITIONS,
} from "../../src/mise-graph/agents/base";

const u41: Scenario = {
	id: "u41",
	name: "MealAgent skeleton: phase enum + transition matrix locks the state machine contract",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// ── Phase enum ─────────────────────────────────────────────────────
		const expectedMealPhases: MealPhase[] = [
			"planned",
			"pre_eve",
			"day_of",
			"cook_window",
			"active_cook",
			"eaten",
			"archived",
		];
		ctx.assert.eq(
			MEAL_PHASES.length,
			expectedMealPhases.length,
			"MEAL_PHASES has 7 entries",
		);
		for (let i = 0; i < expectedMealPhases.length; i++) {
			ctx.assert.eq(
				MEAL_PHASES[i],
				expectedMealPhases[i],
				`MEAL_PHASES[${i}] === "${expectedMealPhases[i]}"`,
			);
		}

		ctx.assert.eq(SHOP_PHASES.length, 3, "SHOP_PHASES has 3 entries");
		ctx.assert.eq(COOK_PHASES.length, 4, "COOK_PHASES has 4 entries");

		// ── Forward path is legal end-to-end ───────────────────────────────
		const forward: Array<[MealPhase, MealPhase]> = [
			["planned", "pre_eve"],
			["pre_eve", "day_of"],
			["day_of", "cook_window"],
			["cook_window", "active_cook"],
			["active_cook", "eaten"],
			["eaten", "archived"],
		];
		for (const [from, to] of forward) {
			ctx.assert.ok(
				isLegalTransition(MEAL_TRANSITIONS, from, to),
				`forward: ${from} → ${to}`,
			);
		}

		// ── Skipping phases is illegal ─────────────────────────────────────
		const illegalForwardSkips: Array<[MealPhase, MealPhase]> = [
			["planned", "day_of"],
			["planned", "active_cook"],
			["pre_eve", "active_cook"],
			["day_of", "eaten"],
			["cook_window", "eaten"],
		];
		for (const [from, to] of illegalForwardSkips) {
			ctx.assert.ok(
				!isLegalTransition(MEAL_TRANSITIONS, from, to),
				`illegal skip: ${from} → ${to}`,
			);
		}

		// ── Every non-terminal phase can be archived ──────────────────────
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
				`cancellable: ${from} → archived`,
			);
		}

		// ── archived is terminal ───────────────────────────────────────────
		for (const to of MEAL_PHASES) {
			if (to === "archived") continue;
			ctx.assert.ok(
				!isLegalTransition(MEAL_TRANSITIONS, "archived", to),
				`archived is terminal: archived → ${to} illegal`,
			);
		}

		// ── Documented backward corrections are legal ──────────────────────
		const backwardCorrections: Array<[MealPhase, MealPhase]> = [
			["pre_eve", "planned"],
			["day_of", "pre_eve"],
			["cook_window", "day_of"],
			["active_cook", "cook_window"],
		];
		for (const [from, to] of backwardCorrections) {
			ctx.assert.ok(
				isLegalTransition(MEAL_TRANSITIONS, from, to),
				`backward correction: ${from} → ${to}`,
			);
		}

		// ── Self-transitions are not legal (no-op should be a guard reject) ──
		for (const phase of MEAL_PHASES) {
			ctx.assert.ok(
				!isLegalTransition(MEAL_TRANSITIONS, phase, phase),
				`self-transition ${phase} → ${phase} is illegal`,
			);
		}

		// ── Sibling state machines pass the same self-transition rule ──────
		for (const phase of SHOP_PHASES) {
			ctx.assert.ok(
				!isLegalTransition(SHOP_TRANSITIONS, phase, phase),
				`shop self-transition ${phase} → ${phase} is illegal`,
			);
		}
		for (const phase of COOK_PHASES) {
			ctx.assert.ok(
				!isLegalTransition(COOK_TRANSITIONS, phase, phase),
				`cook self-transition ${phase} → ${phase} is illegal`,
			);
		}

		// ── ShopAgent forward path ─────────────────────────────────────────
		ctx.assert.ok(
			isLegalTransition(SHOP_TRANSITIONS, "planned", "active_today"),
			"shop forward: planned → active_today",
		);
		ctx.assert.ok(
			isLegalTransition(SHOP_TRANSITIONS, "active_today", "completed"),
			"shop forward: active_today → completed",
		);
		ctx.assert.ok(
			!isLegalTransition(SHOP_TRANSITIONS, "completed", "active_today"),
			"shop completed is terminal",
		);

		// ── CookAgent forward path ─────────────────────────────────────────
		ctx.assert.ok(
			isLegalTransition(COOK_TRANSITIONS, "planned", "pre_session"),
			"cook forward: planned → pre_session",
		);
		ctx.assert.ok(
			isLegalTransition(COOK_TRANSITIONS, "pre_session", "active_session"),
			"cook forward: pre_session → active_session",
		);
		ctx.assert.ok(
			isLegalTransition(COOK_TRANSITIONS, "active_session", "completed"),
			"cook forward: active_session → completed",
		);

		ctx.notes.push(`MEAL_PHASES: ${MEAL_PHASES.join(" → ")}`);
		ctx.notes.push(`SHOP_PHASES: ${SHOP_PHASES.join(" → ")}`);
		ctx.notes.push(`COOK_PHASES: ${COOK_PHASES.join(" → ")}`);
	},
};

export default u41;
