// U114 — Phase 4: HouseholdAgent uses runFiber + onFiberRecovered.
//
// Locks the contract that the four agents touched in Phase 4 wrap their
// long-running in-agent work in `runFiber()` so a worker eviction mid-task
// is recoverable instead of lost. The Agents SDK runtime requires
// `cloudflare:workers`, which throws under Node, so we lock the contract
// via static-source inspection (same pattern as u40 / u41).
//
// What this test pins:
//   1. HouseholdAgent.morningCheckin wraps the brief pipeline in
//      `this.runFiber("morning_brief", ...)` and ships an
//      `onFiberRecovered` hook that handles the `morning_brief` name.
//   2. The pipeline stashes intermediate state (so recovery can short-
//      circuit work that's already durable in D1).
//   3. PlanAgent.routeFinalize wraps the spawn loop in a
//      `finalize_spawn` fiber with a matching recovery hook.
//   4. CookingLeadAgent.onSchedulerTick wraps each tick in a
//      `scheduler_tick` fiber with a matching recovery hook.
//   5. The agents 0.12.3 SDK exports the FiberRecoveryContext type we
//      depend on.

import type { Scenario } from "../lib/types";

const u114: Scenario = {
	id: "u114",
	name: "Phase 4: HouseholdAgent + PlanAgent + CookingLeadAgent wrap multi-step work in Fibers",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const fs = await import("node:fs/promises");
		const path = await import("node:path");
		const { fileURLToPath } = await import("node:url");
		const HERE = path.dirname(fileURLToPath(import.meta.url));
		const AGENTS_DIR = path.resolve(HERE, "../../src/mise-graph/agents");

		// ── 1. agents SDK exposes the Fiber API in installed version ────────
		const agentsTypes = await fs.readFile(
			path.resolve(HERE, "../../node_modules/agents/dist/index.d.ts"),
			"utf8",
		);
		ctx.assert.matches(
			agentsTypes,
			/FiberRecoveryContext/,
			"agents SDK re-exports FiberRecoveryContext from index.d.ts",
		);
		ctx.assert.matches(
			agentsTypes,
			/FiberContext/,
			"agents SDK re-exports FiberContext from index.d.ts",
		);

		// Confirm the Agent base class actually has runFiber/stash/onFiberRecovered.
		const agentApi = await fs.readFile(
			path.resolve(HERE, "../../node_modules/agents/dist/agent-tool-types-DSteYkkS.d.ts"),
			"utf8",
		);
		ctx.assert.matches(
			agentApi,
			/runFiber<T>\(name: string, fn: \(ctx: FiberContext\) => Promise<T>\): Promise<T>/,
			"Agent.runFiber signature matches expected (string, fn) → Promise",
		);
		ctx.assert.matches(
			agentApi,
			/stash\(data: unknown\): void/,
			"Agent.stash signature matches expected (data) → void",
		);
		ctx.assert.matches(
			agentApi,
			/onFiberRecovered\(_ctx: FiberRecoveryContext\): Promise<void>/,
			"Agent.onFiberRecovered signature matches",
		);
		ctx.assert.matches(
			agentApi,
			/keepAlive\(\): Promise<\(\) => void>/,
			"Agent.keepAlive present (used implicitly inside runFiber)",
		);

		// ── 2. HouseholdAgent: morning_brief fiber + recovery ────────────────
		const householdSrc = await fs.readFile(
			path.join(AGENTS_DIR, "household-agent.ts"),
			"utf8",
		);
		ctx.assert.matches(
			householdSrc,
			/this\.runFiber\(\s*["']morning_brief["']/,
			"HouseholdAgent.morningCheckin wraps work in runFiber('morning_brief', ...)",
		);
		ctx.assert.matches(
			householdSrc,
			/async onFiberRecovered\(ctx: FiberRecoveryContext\)/,
			"HouseholdAgent declares onFiberRecovered(ctx: FiberRecoveryContext)",
		);
		ctx.assert.matches(
			householdSrc,
			/ctx\.name === ["']morning_brief["']/,
			"HouseholdAgent.onFiberRecovered handles the morning_brief fiber name",
		);
		ctx.assert.matches(
			householdSrc,
			/MorningBriefSnapshot/,
			"HouseholdAgent declares a MorningBriefSnapshot type for stash payloads",
		);
		// Stash schedule has at least two checkpoints (after compute, after persist).
		const stashCount = (householdSrc.match(/ctx\.stash\(/g) || []).length;
		ctx.assert.gte(
			stashCount,
			2,
			"runMorningBriefPipeline stashes at least twice (after compute + after persist)",
		);
		ctx.assert.matches(
			householdSrc,
			/persisted_id/,
			"morning brief snapshot tracks persisted_id so recovery can skip the persist step",
		);

		// ── 3. PlanAgent: finalize_spawn fiber + recovery ────────────────────
		const planSrc = await fs.readFile(
			path.join(AGENTS_DIR, "plan-agent.ts"),
			"utf8",
		);
		ctx.assert.matches(
			planSrc,
			/this\.runFiber\(\s*["']finalize_spawn["']/,
			"PlanAgent.routeFinalize wraps the spawn loop in runFiber('finalize_spawn', ...)",
		);
		ctx.assert.matches(
			planSrc,
			/async onFiberRecovered\(ctx: FiberRecoveryContext\)/,
			"PlanAgent declares onFiberRecovered(ctx: FiberRecoveryContext)",
		);
		ctx.assert.matches(
			planSrc,
			/ctx\.name === ["']finalize_spawn["']/,
			"PlanAgent.onFiberRecovered handles the finalize_spawn fiber name",
		);
		ctx.assert.matches(
			planSrc,
			/spawned_meals/,
			"finalize_spawn snapshot tracks spawned_meals for resumption",
		);
		ctx.assert.matches(
			planSrc,
			/spawned_shops/,
			"finalize_spawn snapshot tracks spawned_shops for resumption",
		);
		ctx.assert.matches(
			planSrc,
			/FinalizeFiberSnapshot/,
			"PlanAgent exports a FinalizeFiberSnapshot interface",
		);

		// ── 4. CookingLeadAgent: scheduler_tick fiber + recovery ─────────────
		const leadSrc = await fs.readFile(
			path.join(AGENTS_DIR, "cooking-lead-agent.ts"),
			"utf8",
		);
		ctx.assert.matches(
			leadSrc,
			/this\.runFiber\(\s*["']scheduler_tick["']/,
			"CookingLeadAgent.onSchedulerTick wraps the tick in runFiber('scheduler_tick', ...)",
		);
		ctx.assert.matches(
			leadSrc,
			/async onFiberRecovered\(ctx: FiberRecoveryContext\)/,
			"CookingLeadAgent declares onFiberRecovered(ctx: FiberRecoveryContext)",
		);
		ctx.assert.matches(
			leadSrc,
			/ctx\.name === ["']scheduler_tick["']/,
			"CookingLeadAgent.onFiberRecovered handles the scheduler_tick fiber name",
		);
		ctx.assert.matches(
			leadSrc,
			/SchedulerTickFiberSnapshot/,
			"CookingLeadAgent exports a SchedulerTickFiberSnapshot interface",
		);
		// Stash schedule: at minimum input → output → applied.
		const tickStashCount = (leadSrc.match(/ctx\.stash\(/g) || []).length;
		ctx.assert.gte(
			tickStashCount,
			3,
			"runSchedulerTickFiber stashes at each step (input, output, applied)",
		);

		// ── 5. No agent re-runs heavy work outside its fiber ─────────────────
		// (Sanity: the original `morningCheckin` body should no longer call
		// computeMorningBrief directly outside the fiber wrapper.)
		const hhMorningCallout = householdSrc.match(/async morningCheckin\(\)[\s\S]*?(?=\n\t\/\*\*|\n\tprivate|\n\tasync )/);
		ctx.assert.ok(
			!!hhMorningCallout,
			"morningCheckin body extracted",
		);
		if (hhMorningCallout) {
			ctx.assert.matches(
				hhMorningCallout[0],
				/this\.runFiber/,
				"morningCheckin body delegates to runFiber",
			);
			ctx.assert.ok(
				!/await computeMorningBrief\(/.test(hhMorningCallout[0]),
				"morningCheckin no longer calls computeMorningBrief directly outside the fiber",
			);
		}

		ctx.notes.push(`agents SDK version: 0.12.3 (built-in Fiber API)`);
		ctx.notes.push(`HouseholdAgent stash count: ${stashCount}`);
		ctx.notes.push(`CookingLeadAgent tick stash count: ${tickStashCount}`);
		ctx.notes.push("Phase 4 fibers: morning_brief, finalize_spawn, scheduler_tick, transition_to_<phase>");
	},
};

export default u114;
