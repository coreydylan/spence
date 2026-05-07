// U118 — Phase 2: OnboardingWorkflow shape.
//
// Locks the contract that OnboardingWorkflow:
//   1. Extends Cloudflare's WorkflowEntrypoint (not the local shim).
//   2. Walks tier 0 (5 questions) and tier 1 (5 questions) using
//      `step.do` / `step.waitForEvent`.
//   3. Persists each answer via `household_onboarding_answer` and each
//      skip via `household_onboarding_skip`.
//   4. Branches on the `tier_1_pantry_intake` answer to optionally run
//      the `household_set_pantry_bulk` sub-flow.
//   5. Reads tier completion via `household_onboarding_status`.
//
// Static-source inspection (same pattern as u115) — Cloudflare's
// Workflows runtime is not available under Node, so we lock the
// contract by reading the source.

import type { Scenario } from "../lib/types";

const u118: Scenario = {
	id: "u118",
	name: "Phase 2: OnboardingWorkflow walks tier 0 + tier 1 + bulk intake",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const fs = await import("node:fs/promises");
		const path = await import("node:path");
		const { fileURLToPath } = await import("node:url");
		const HERE = path.dirname(fileURLToPath(import.meta.url));
		const WF_DIR = path.resolve(HERE, "../../src/workflows");

		const src = await fs.readFile(path.join(WF_DIR, "onboarding-workflow.ts"), "utf8");

		// 1. Extends WorkflowEntrypoint from cloudflare:workers
		ctx.assert.matches(
			src,
			/from\s+["']cloudflare:workers["']/,
			"imports from cloudflare:workers (real runtime, not the shim)",
		);
		ctx.assert.matches(
			src,
			/class OnboardingWorkflow extends WorkflowEntrypoint/,
			"OnboardingWorkflow extends WorkflowEntrypoint",
		);

		// 2. The id is the household_id (idempotent per household)
		ctx.assert.matches(
			src,
			/household_id:\s*string/,
			"params include household_id",
		);

		// 3. Tier 0 + tier 1 question loops
		ctx.assert.matches(
			src,
			/TIER_0_QUESTIONS/,
			"iterates TIER_0_QUESTIONS",
		);
		ctx.assert.matches(
			src,
			/TIER_1_QUESTIONS/,
			"iterates TIER_1_QUESTIONS",
		);

		// 4. Per-question pattern: ask → waitForEvent → record/skip
		ctx.assert.matches(
			src,
			/waitForEvent<OnboardingAnswerEvent>/,
			"waits for onboarding_answer event per question",
		);
		ctx.assert.matches(
			src,
			/type:\s*"onboarding_answer"/,
			"event type is onboarding_answer",
		);
		ctx.assert.matches(
			src,
			/household_onboarding_answer/,
			"records answers via household_onboarding_answer",
		);
		ctx.assert.matches(
			src,
			/household_onboarding_skip/,
			"records skips via household_onboarding_skip",
		);
		ctx.assert.matches(
			src,
			/household_onboarding_status/,
			"reads tier status via household_onboarding_status",
		);

		// 5. Bulk intake sub-flow gated on pantry_intake answer
		ctx.assert.matches(
			src,
			/tier_1_pantry_intake/,
			"sniffs the tier_1_pantry_intake answer",
		);
		ctx.assert.matches(
			src,
			/household_set_pantry_bulk/,
			"calls household_set_pantry_bulk when user picked bulk/photo",
		);
		ctx.assert.matches(
			src,
			/type:\s*"bulk_intake"/,
			"waits for bulk_intake event when running the sub-flow",
		);

		// 6. Per-question step naming so checkpointing is granular
		ctx.assert.matches(
			src,
			/`ask_\$\{q\.kind\}`/,
			"step.do('ask_<kind>') per question",
		);
		ctx.assert.matches(
			src,
			/`record_\$\{q\.kind\}`/,
			"step.do('record_<kind>') per persisted answer",
		);
		ctx.assert.matches(
			src,
			/`skip_\$\{q\.kind\}`/,
			"step.do('skip_<kind>') per skip",
		);

		// 7. Worker exports the class
		const workerSrc = await fs.readFile(
			path.resolve(HERE, "../../src/mise-graph-worker.ts"),
			"utf8",
		);
		ctx.assert.matches(
			workerSrc,
			/export\s*\{\s*OnboardingWorkflow\s*\}\s*from\s*["']\.\/workflows\/onboarding-workflow["']/,
			"mise-graph-worker.ts re-exports OnboardingWorkflow",
		);

		// 8. wrangler.mise.toml binds the workflow with the right name
		const wrangler = await fs.readFile(
			path.resolve(HERE, "../../wrangler.mise.toml"),
			"utf8",
		);
		ctx.assert.matches(
			wrangler,
			/binding\s*=\s*"ONBOARDING_WORKFLOW"[\s\S]*?class_name\s*=\s*"OnboardingWorkflow"/,
			"wrangler.mise.toml binds ONBOARDING_WORKFLOW to OnboardingWorkflow",
		);
		ctx.assert.matches(
			wrangler,
			/name\s*=\s*"spence-onboarding"/,
			"wrangler.mise.toml registers the spence-onboarding workflow name",
		);

		// 9. Trigger routes wired in the worker
		ctx.assert.matches(
			workerSrc,
			/\/agent\/workflow\//,
			"worker has /agent/workflow/* trigger routes",
		);
		ctx.assert.matches(
			workerSrc,
			/sendEvent\(\{\s*type:\s*body\.type/,
			"events route forwards to env[NAME].sendEvent",
		);
		ctx.assert.matches(
			workerSrc,
			/\.status\(\)/,
			"status route calls handle.status()",
		);

		ctx.notes.push("OnboardingWorkflow walks 10 questions + optional bulk intake");
	},
};

export default u118;
