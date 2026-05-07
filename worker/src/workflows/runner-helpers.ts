// Phase 2 — Cloudflare Workflows runner helpers.
//
// Each workflow class (OnboardingWorkflow, PlanningWorkflow,
// CookSessionDebriefWorkflow) executes inside the Cloudflare Workflows
// runtime, where `step.do(...)` checkpoints the body and replays from the
// failed step on retry. The bodies want a tight `mcp(name, args)` API
// rather than re-importing each tool by name, so this module wraps
// `callPlanWorldTool` from the existing plan-world MCP server.
//
// The wrapper also normalises a few things the workflows need:
//   - Tags every call with `caller_kind: "system"` + a synthetic
//     `caller_id` of `workflow:<id>` so the agent-trace replay UI can
//     attribute mutations to the right workflow run.
//   - Returns the result un-stringified (callPlanWorldTool already returns
//     a Record<string, unknown>) so workflow steps can `Promise.all([...])`
//     gather + persist via plain JS.
//
// Importantly: this module does NOT import `cloudflare:workers`. The
// workflow classes import that module themselves; this file is a pure
// helper that runs the same way under Node (test) and Workers (prod).

import type { MiseGraphEnv } from "../mise-graph/types";
import { callPlanWorldTool } from "../mise-graph/plan-world-mcp";

export interface WorkflowMcpContext {
	caller_kind?: "system" | "agent" | "human" | "cron" | "replan" | "subagent";
	caller_id?: string;
	parent_trace_id?: string | null;
}

/**
 * Run a plan-world MCP tool from inside a workflow step.
 *
 * The workflow runtime memoises the step.do() body's return value, so we
 * keep this shape stable: name, args → JSON-serializable record. Throws on
 * tool errors so step.do() retries / surfaces the failure.
 */
export async function mcp(
	env: MiseGraphEnv,
	name: string,
	args: Record<string, unknown> = {},
	ctx: WorkflowMcpContext = {},
): Promise<Record<string, unknown>> {
	return await callPlanWorldTool(name, args, env, {
		caller_kind: ctx.caller_kind ?? "system",
		caller_id: ctx.caller_id ?? null,
		parent_trace_id: ctx.parent_trace_id ?? null,
	});
}

/**
 * Bind a `WorkflowMcpContext` once at the top of a workflow run so each
 * step body can call `boundMcp(name, args)` without re-passing the
 * caller_id everywhere.
 */
export function bindMcp(
	env: MiseGraphEnv,
	ctx: WorkflowMcpContext,
): (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>> {
	return (name, args = {}) => mcp(env, name, args, ctx);
}

/**
 * Build a stable caller_id for a workflow instance. Workflow IDs are
 * typed as the household_id (onboarding) / plan_id (planning) /
 * cook_session_id (debrief), so this is just a thin prefix.
 */
export function workflowCallerId(workflowName: string, instanceId: string): string {
	return `workflow:${workflowName}:${instanceId}`;
}

// ─── step.do shim ──────────────────────────────────────────────────────────
//
// Cloudflare's `WorkflowStep.do<T>` constrains T via `Rpc.Serializable<T>`
// — a recursive structural type that's overzealous for our JSON-shaped
// domain types (Records, plain objects with optional fields). The
// existing `workflow-runner.ts` solved this with a stepDo wrapper that
// casts through `unknown`. We expose the same shim here so all three
// Phase 2 workflows can share it.

import type { WorkflowStep, WorkflowSleepDuration } from "cloudflare:workers";

export interface StepConfig {
	retries?: { limit: number; delay: number; backoff?: "constant" | "linear" | "exponential" };
	timeout?: number | string;
}

type RelaxedStep = {
	do<T>(name: string, callback: (ctx: { attempt: number }) => Promise<T>): Promise<T>;
	do<T>(name: string, config: unknown, callback: (ctx: { attempt: number }) => Promise<T>): Promise<T>;
	sleep(name: string, duration: number | string): Promise<void>;
	sleepUntil(name: string, timestamp: Date | number): Promise<void>;
	waitForEvent<T>(name: string, options: { type: string; timeout?: number | string }): Promise<{ payload: T; timestamp: Date; type: string }>;
};

/**
 * Wrap a `WorkflowStep` so the rest of our workflow code can pass plain
 * `Record<string, unknown>` / typed-object returns through `step.do`
 * without dancing with `Rpc.Serializable<T>`. The runtime values are all
 * JSON, which IS what Cloudflare's runtime serialiser handles — the
 * constraint is just stricter at the type-system level than necessary.
 */
export function relaxStep(step: WorkflowStep): RelaxedStep {
	return step as unknown as RelaxedStep;
}

/**
 * Coerce a "30 minutes" / "24 hours" / "7 days" string to the
 * `WorkflowSleepDuration` template-literal type. The runtime accepts
 * the same strings; we only need this cast because TypeScript can't
 * narrow a generic string back to the template form.
 */
export function asSleepDuration(s: string | number | WorkflowSleepDuration): WorkflowSleepDuration {
	return s as WorkflowSleepDuration;
}
