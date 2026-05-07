// U119 — Phase 2: PlanningWorkflow shape.
//
// Locks the contract that PlanningWorkflow:
//   1. Extends Cloudflare's WorkflowEntrypoint.
//   2. Gathers seasonality + weather + calendar + signals in parallel
//      with `Promise.all([step.do, …])`.
//   3. Calls `callMeshClaude` inside a `propose_dishes` step.
//   4. Per-dish approval loop using `step.waitForEvent<DishDecisionEvent>`.
//   5. Mandatory persistence: plan_create + plan_compose_meal × N.
//   6. Audit step (plan_audit, run_critics: "all").
//   7. Finalize step (plan_finalize) hands off to MealAgents.

import type { Scenario } from "../lib/types";

const u119: Scenario = {
	id: "u119",
	name: "Phase 2: PlanningWorkflow gather → propose → approve → persist → audit → finalize",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const fs = await import("node:fs/promises");
		const path = await import("node:path");
		const { fileURLToPath } = await import("node:url");
		const HERE = path.dirname(fileURLToPath(import.meta.url));
		const WF_DIR = path.resolve(HERE, "../../src/workflows");

		const src = await fs.readFile(path.join(WF_DIR, "planning-workflow.ts"), "utf8");

		// 1. Extends WorkflowEntrypoint
		ctx.assert.matches(
			src,
			/from\s+["']cloudflare:workers["']/,
			"imports from cloudflare:workers",
		);
		ctx.assert.matches(
			src,
			/class PlanningWorkflow extends WorkflowEntrypoint/,
			"PlanningWorkflow extends WorkflowEntrypoint",
		);

		// 2. Parallel data gather via Promise.all
		ctx.assert.matches(
			src,
			/Promise\.all\(\[/,
			"data gather uses Promise.all",
		);
		ctx.assert.matches(
			src,
			/inspire_read_seasonality/,
			"reads seasonality",
		);
		ctx.assert.matches(
			src,
			/inspire_read_weather/,
			"reads weather",
		);
		ctx.assert.matches(
			src,
			/inspire_read_calendar/,
			"reads calendar",
		);
		ctx.assert.matches(
			src,
			/inspire_read_household_signals/,
			"reads household signals",
		);

		// 3. LLM proposes dishes via mesh-claude bridge
		ctx.assert.matches(
			src,
			/callMeshClaude/,
			"calls mesh-claude bridge for dish proposal",
		);
		ctx.assert.matches(
			src,
			/"propose_dishes"/,
			"step is named propose_dishes",
		);

		// 4. Per-dish approval loop
		ctx.assert.matches(
			src,
			/waitForEvent<DishDecisionEvent>/,
			"waits for dish_decision events per dish",
		);
		ctx.assert.matches(
			src,
			/type:\s*"dish_decision"/,
			"event type is dish_decision",
		);
		ctx.assert.matches(
			src,
			/`approve_\$\{dish\.id\}`/,
			"per-dish event name 'approve_<id>'",
		);

		// 5. Mandatory persistence
		ctx.assert.matches(
			src,
			/"create_plan"/,
			"step.do('create_plan')",
		);
		ctx.assert.matches(
			src,
			/plan_create/,
			"calls plan_create",
		);
		ctx.assert.matches(
			src,
			/plan_compose_meal/,
			"calls plan_compose_meal per approved dish",
		);
		ctx.assert.matches(
			src,
			/`compose_\$\{slotKey\}`/,
			"per-meal step.do name 'compose_<date>_<slot>'",
		);

		// 6. Audit + finalize
		ctx.assert.matches(
			src,
			/plan_audit/,
			"calls plan_audit",
		);
		ctx.assert.matches(
			src,
			/run_critics:\s*"all"/,
			"audit runs all critics",
		);
		ctx.assert.matches(
			src,
			/plan_finalize/,
			"calls plan_finalize as the handoff step",
		);

		// 7. Worker exports the class
		const workerSrc = await fs.readFile(
			path.resolve(HERE, "../../src/mise-graph-worker.ts"),
			"utf8",
		);
		ctx.assert.matches(
			workerSrc,
			/export\s*\{\s*PlanningWorkflow\s*\}\s*from\s*["']\.\/workflows\/planning-workflow["']/,
			"mise-graph-worker.ts re-exports PlanningWorkflow",
		);

		// 8. wrangler binding
		const wrangler = await fs.readFile(
			path.resolve(HERE, "../../wrangler.mise.toml"),
			"utf8",
		);
		ctx.assert.matches(
			wrangler,
			/binding\s*=\s*"PLANNING_WORKFLOW"[\s\S]*?class_name\s*=\s*"PlanningWorkflow"/,
			"wrangler binds PLANNING_WORKFLOW to PlanningWorkflow",
		);
		ctx.assert.matches(
			wrangler,
			/name\s*=\s*"spence-planning"/,
			"wrangler registers the spence-planning workflow name",
		);

		ctx.notes.push("PlanningWorkflow: 4-way parallel gather → propose → approve → persist → audit → finalize");
	},
};

export default u119;
