// Cloudflare Workers runtime shim.
//
// The mise-graph workflow-runner.ts needs the WorkflowEntrypoint base class
// at runtime (for `class PlannerWorkflow extends WorkflowEntrypoint`), but
// the `cloudflare:workers` module is ONLY resolvable inside the Workers
// runtime (and the wrangler bundler). Node + tsx (used by our test runner)
// cannot resolve it.
//
// This shim:
//   - In production (Workers runtime / wrangler bundle): re-exports the real
//     class via dynamic require, so the extends clause works as expected.
//   - In Node / tsx tests: returns a stub base class. The tests NEVER
//     instantiate PlannerWorkflow — they call runPipeline directly — so the
//     stub never executes any workflow logic.
//
// Type-side: `WorkflowEntrypointType<E, P>` resolves to the real generic
// class signature from @cloudflare/workers-types, so `class PlannerWorkflow
// extends WorkflowEntrypointBase<MiseGraphEnv, PlanWorkflowParams>` is fully
// typed even though the runtime class is the stub.

// Type-only import of the real class shape.
import type {
	WorkflowEntrypoint as RealWorkflowEntrypoint,
	WorkflowStep as RealWorkflowStep,
	WorkflowEvent as RealWorkflowEvent,
} from "cloudflare:workers";

export type WorkflowEntrypointType<E, P> = RealWorkflowEntrypoint<E, P>;
export type WorkflowStepType = RealWorkflowStep;
export type WorkflowEventType<P> = RealWorkflowEvent<P>;

// Stub base class used when cloudflare:workers is unavailable (Node/tsx).
// The constructor signature matches the real one (ctx, env).
class WorkflowEntrypointStub<E, P> {
	protected ctx: ExecutionContext;
	protected env: E;
	constructor(ctx: ExecutionContext, env: E) {
		this.ctx = ctx;
		this.env = env;
		// Mark P as used to satisfy strict generic constraints.
		void (null as unknown as P);
	}
	async run(_event: unknown, _step: unknown): Promise<unknown> {
		throw new Error("WorkflowEntrypointStub.run called outside the Cloudflare Workers runtime");
	}
}

// Try to load the real class. If the module isn't resolvable (Node/tsx),
// fall back to the stub. The cast through `unknown` is needed because the
// real class's branded-symbol private member (`[__WORKFLOW_ENTRYPOINT_BRAND]`)
// is not present on our stub.
//
// We use a `Function`-based dynamic require to avoid bundlers eagerly
// resolving the module specifier.
function loadWorkflowEntrypoint(): unknown {
	try {
		// eslint-disable-next-line @typescript-eslint/no-implied-eval
		const dynamicRequire = new Function("specifier", "return require(specifier);") as (s: string) => unknown;
		const mod = dynamicRequire("cloudflare:workers") as { WorkflowEntrypoint?: unknown };
		if (mod && typeof mod.WorkflowEntrypoint !== "undefined") {
			return mod.WorkflowEntrypoint;
		}
	} catch {
		// fall through
	}
	return WorkflowEntrypointStub;
}

export const WorkflowEntrypointBase = loadWorkflowEntrypoint() as unknown as {
	new <E, P>(ctx: ExecutionContext, env: E): RealWorkflowEntrypoint<E, P>;
};
