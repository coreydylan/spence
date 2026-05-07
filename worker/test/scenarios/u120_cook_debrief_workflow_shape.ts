// U120 — Phase 2: CookSessionDebriefWorkflow shape.
//
// Locks the contract that:
//   1. CookSessionDebriefWorkflow extends Cloudflare's WorkflowEntrypoint.
//   2. It sleeps 30 minutes after the meal (durable hibernation).
//   3. Asks for a meal_rating event with a 24h timeout.
//   4. Persists the rating via recordMealFeedback (writes mise_meal_feedback).
//   5. Folds high/low ratings back into the trait engine via
//      household_observe_response.
//   6. MealAgent spawns the workflow on `eaten` transitions.

import type { Scenario } from "../lib/types";

const u120: Scenario = {
	id: "u120",
	name: "Phase 2: CookSessionDebriefWorkflow waits, rates, persists, observes",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const fs = await import("node:fs/promises");
		const path = await import("node:path");
		const { fileURLToPath } = await import("node:url");
		const HERE = path.dirname(fileURLToPath(import.meta.url));
		const WF_DIR = path.resolve(HERE, "../../src/workflows");

		const src = await fs.readFile(path.join(WF_DIR, "cook-debrief-workflow.ts"), "utf8");

		// 1. Extends WorkflowEntrypoint
		ctx.assert.matches(
			src,
			/from\s+["']cloudflare:workers["']/,
			"imports from cloudflare:workers",
		);
		ctx.assert.matches(
			src,
			/class CookSessionDebriefWorkflow extends WorkflowEntrypoint/,
			"CookSessionDebriefWorkflow extends WorkflowEntrypoint",
		);

		// 2. Durable post-meal sleep
		ctx.assert.matches(
			src,
			/\.sleep\("wait_for_post_meal"/,
			"step.sleep('wait_for_post_meal') for the 30-min delay",
		);
		ctx.assert.matches(
			src,
			/30 minutes/,
			"default sleep is 30 minutes",
		);

		// 3. waitForEvent for the rating
		ctx.assert.matches(
			src,
			/waitForEvent<MealRatingEvent>/,
			"waits for the typed MealRatingEvent",
		);
		ctx.assert.matches(
			src,
			/type:\s*"meal_rating"/,
			"event type is meal_rating",
		);
		ctx.assert.matches(
			src,
			/24 hours/,
			"24h timeout for rating",
		);

		// 4. Persists via recordMealFeedback
		ctx.assert.matches(
			src,
			/recordMealFeedback\(this\.env/,
			"calls recordMealFeedback to write mise_meal_feedback",
		);
		ctx.assert.matches(
			src,
			/"record_rating"/,
			"step.do('record_rating')",
		);

		// 5. Trait observation
		ctx.assert.matches(
			src,
			/household_observe_response/,
			"folds rating into household_observe_response",
		);
		ctx.assert.matches(
			src,
			/observation_kind:\s*"meal_loved"/,
			"high rating writes meal_loved observation",
		);
		ctx.assert.matches(
			src,
			/observation_kind:\s*"meal_rejected"/,
			"low rating writes meal_rejected observation",
		);
		ctx.assert.matches(
			src,
			/comfort_vs_adventure/,
			"observation feeds the comfort_vs_adventure trait",
		);

		// 6. Worker exports the class
		const workerSrc = await fs.readFile(
			path.resolve(HERE, "../../src/mise-graph-worker.ts"),
			"utf8",
		);
		ctx.assert.matches(
			workerSrc,
			/export\s*\{\s*CookSessionDebriefWorkflow\s*\}\s*from\s*["']\.\/workflows\/cook-debrief-workflow["']/,
			"mise-graph-worker.ts re-exports CookSessionDebriefWorkflow",
		);

		// 7. wrangler binding
		const wrangler = await fs.readFile(
			path.resolve(HERE, "../../wrangler.mise.toml"),
			"utf8",
		);
		ctx.assert.matches(
			wrangler,
			/binding\s*=\s*"COOK_DEBRIEF_WORKFLOW"[\s\S]*?class_name\s*=\s*"CookSessionDebriefWorkflow"/,
			"wrangler binds COOK_DEBRIEF_WORKFLOW to CookSessionDebriefWorkflow",
		);
		ctx.assert.matches(
			wrangler,
			/name\s*=\s*"spence-cook-debrief"/,
			"wrangler registers the spence-cook-debrief workflow name",
		);

		// 8. MealAgent spawns the workflow on eaten transition
		const mealSrc = await fs.readFile(
			path.resolve(HERE, "../../src/mise-graph/agents/meal-agent.ts"),
			"utf8",
		);
		ctx.assert.matches(
			mealSrc,
			/spawnCookDebriefWorkflow/,
			"meal-agent.ts has spawnCookDebriefWorkflow",
		);
		ctx.assert.matches(
			mealSrc,
			/COOK_DEBRIEF_WORKFLOW/,
			"meal-agent.ts references the COOK_DEBRIEF_WORKFLOW binding",
		);
		ctx.assert.matches(
			mealSrc,
			/phase === "eaten"[\s\S]*?spawnCookDebriefWorkflow/,
			"applyPhaseStateHooks spawns the debrief on eaten",
		);

		// 9. Worker still has the trigger routes (events + status) for the
		//    chat surface to drive the workflow.
		ctx.assert.matches(
			workerSrc,
			/cook_debrief/,
			"worker recognises cook_debrief in workflow route mapping",
		);
		ctx.assert.matches(
			workerSrc,
			/COOK_DEBRIEF_WORKFLOW/,
			"worker pickWorkflowBinding maps cook_debrief → COOK_DEBRIEF_WORKFLOW",
		);

		// 10. Phase 4 fiber wrapper still intact (we added additively)
		ctx.assert.matches(
			mealSrc,
			/this\.runFiber\(`transition_to_\$\{to\}`/,
			"Phase 4 fiber wrapper is preserved",
		);
		ctx.assert.matches(
			mealSrc,
			/async onFiberRecovered/,
			"Phase 4 fiber recovery handler is preserved",
		);

		ctx.notes.push("CookSessionDebriefWorkflow: 30min delay → rating → persist → observe");
		ctx.notes.push("Auto-triggered by MealAgent.applyPhaseStateHooks on eaten");
	},
};

export default u120;
