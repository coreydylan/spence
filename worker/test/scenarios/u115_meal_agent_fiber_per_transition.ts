// U115 — Phase 4: MealAgent wraps each phase entry in its own Fiber.
//
// Locks the contract that `MealAgent.transitionTo` wraps the
// side-effect-heavy phase-entry handler in a `runFiber` checkpointed by
// the SDK, with a matching `onFiberRecovered` hook. Static-source
// inspection (same pattern as u40 / u41 / u114) since the Agents SDK
// runtime is not available under Node.
//
// What this test pins:
//   1. transitionTo wraps the handler+side-effects in
//      `runFiber("transition_to_<phase>", ...)`.
//   2. The fiber stashes a `PhaseTransitionFiberSnapshot` describing how
//      far the transition got: phase name, handler result, and an
//      `applied` flag once side-effects have landed.
//   3. `onFiberRecovered` recognises any `transition_to_*` fiber name and
//      replays the missing side-effects (or re-runs the handler) instead
//      of writing the audit row twice.
//   4. The pure phase handlers (pre_eve_entry, day_of_entry, etc.) are
//      not modified — only the wrapping in MealAgent changed. The handler
//      contract (PhaseHandlerResult shape) is unchanged.
//   5. applyHandlerResult / applyPhaseStateHooks / scheduleNextPhaseAlarm
//      are split out as separate methods so the recovery hook can call
//      them without re-running the (potentially expensive) handler.

import type { Scenario } from "../lib/types";

const u115: Scenario = {
	id: "u115",
	name: "Phase 4: MealAgent.transitionTo wraps every phase entry in a Fiber",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const fs = await import("node:fs/promises");
		const path = await import("node:path");
		const { fileURLToPath } = await import("node:url");
		const HERE = path.dirname(fileURLToPath(import.meta.url));
		const AGENTS_DIR = path.resolve(HERE, "../../src/mise-graph/agents");

		const mealSrc = await fs.readFile(
			path.join(AGENTS_DIR, "meal-agent.ts"),
			"utf8",
		);

		// ── 1. transitionTo uses runFiber('transition_to_<phase>') ──────────
		ctx.assert.matches(
			mealSrc,
			/this\.runFiber\(\s*`transition_to_\$\{(?:to|[a-zA-Z_]+)\}`/,
			"transitionTo wraps work in runFiber with a per-phase fiber name",
		);

		// ── 2. PhaseTransitionFiberSnapshot type defined ────────────────────
		ctx.assert.matches(
			mealSrc,
			/export interface PhaseTransitionFiberSnapshot/,
			"meal-agent.ts exports PhaseTransitionFiberSnapshot",
		);
		ctx.assert.matches(
			mealSrc,
			/applied\?: boolean/,
			"snapshot tracks 'applied' flag so recovery knows when to skip",
		);
		ctx.assert.matches(
			mealSrc,
			/result\?: PhaseHandlerResult/,
			"snapshot embeds the PhaseHandlerResult so recovery can replay side-effects without re-running the handler",
		);

		// ── 3. onFiberRecovered hook recognises transition_to_* names ───────
		ctx.assert.matches(
			mealSrc,
			/async onFiberRecovered\(ctx: FiberRecoveryContext\)/,
			"MealAgent declares onFiberRecovered(ctx: FiberRecoveryContext)",
		);
		ctx.assert.matches(
			mealSrc,
			/startsWith\(["']transition_to_["']\)/,
			"onFiberRecovered branches on transition_to_* fiber names",
		);

		// ── 4. The pure phase handlers in meal-phase-handlers.ts are NOT modified ──
		const handlersSrc = await fs.readFile(
			path.join(AGENTS_DIR, "meal-phase-handlers.ts"),
			"utf8",
		);
		ctx.assert.ok(
			!/runFiber/.test(handlersSrc),
			"meal-phase-handlers.ts stays pure (no runFiber inside the handlers themselves)",
		);
		ctx.assert.ok(
			!/this\.stash/.test(handlersSrc),
			"meal-phase-handlers.ts stays pure (no this.stash inside the handlers themselves)",
		);
		// Sanity: each documented entry handler still exists.
		const expectedHandlers = [
			"pre_eve_entry",
			"day_of_entry",
			"cook_window_entry",
			"active_cook_entry",
			"eaten_entry",
			"archived_entry",
			"cancelled_entry",
		];
		for (const handler of expectedHandlers) {
			ctx.assert.matches(
				handlersSrc,
				new RegExp(`export (?:async )?function ${handler}\\b`),
				`meal-phase-handlers exports ${handler}`,
			);
		}

		// ── 5. Helper methods split out so recovery can replay side-effects ─
		ctx.assert.matches(
			mealSrc,
			/private async applyPhaseStateHooks\(/,
			"MealAgent splits applyPhaseStateHooks for replay",
		);
		ctx.assert.matches(
			mealSrc,
			/private async scheduleNextPhaseAlarm\(/,
			"MealAgent splits scheduleNextPhaseAlarm for replay",
		);
		ctx.assert.matches(
			mealSrc,
			/private async runPhaseEntryInner\(/,
			"MealAgent renames the pure dispatch path to runPhaseEntryInner",
		);

		// ── 6. The fiber wrapper stashes at least three checkpoints: empty,
		//      result, applied — so recovery has fine-grained resume info. ──
		const transitionBlock = mealSrc.match(/this\.runFiber\(`transition_to_\$\{to\}`[\s\S]*?\}\);/);
		ctx.assert.ok(
			!!transitionBlock,
			"runFiber('transition_to_${to}', ...) block extracted",
		);
		if (transitionBlock) {
			const stashes = (transitionBlock[0].match(/fiberCtx\.stash\(/g) || []).length;
			ctx.assert.gte(
				stashes,
				3,
				"transition fiber stashes at start, after handler, and after side-effects",
			);
			ctx.assert.matches(
				transitionBlock[0],
				/applyHandlerResult/,
				"fiber body calls applyHandlerResult after handler returns",
			);
			ctx.assert.matches(
				transitionBlock[0],
				/applyPhaseStateHooks/,
				"fiber body calls applyPhaseStateHooks after handler returns",
			);
			ctx.assert.matches(
				transitionBlock[0],
				/scheduleNextPhaseAlarm/,
				"fiber body schedules the next-phase alarm inside the fiber",
			);
		}

		// ── 7. The audit row + pre-state-flip happen BEFORE the fiber so a
		//      crash inside the fiber leaves a clean record (the row + state
		//      are committed; the recovery hook just needs to finish the
		//      side-effects). ────────────────────────────────────────────────
		const transitionToFn = mealSrc.match(/async transitionTo\([\s\S]*?\n\t\}\n\n\t\/\*\*/);
		if (transitionToFn) {
			const auditIdx = transitionToFn[0].indexOf("INSERT INTO phase_transitions");
			const setStateIdx = transitionToFn[0].indexOf("phase: to, last_transition_at_ms: now");
			const fiberIdx = transitionToFn[0].indexOf("this.runFiber(");
			ctx.assert.gt(
				fiberIdx,
				auditIdx,
				"audit row insert is before the fiber wrapper",
			);
			ctx.assert.gt(
				fiberIdx,
				setStateIdx,
				"phase state flip is before the fiber wrapper",
			);
		}

		ctx.notes.push("transition fibers: transition_to_planned/pre_eve/day_of/cook_window/active_cook/eaten/archived");
		ctx.notes.push("Phase handlers stayed pure (no SDK coupling)");
	},
};

export default u115;
