// Cloudflare Workflows wrapper for the Spence mise-graph planner.
//
// Each phase of the compose → audit → revise → polish → persist pipeline
// becomes its own `step.do()` so transient bridge errors retry from the
// failed step, plan state survives Worker restarts mid-flight, and we get
// an audit trail of which step ran when.
//
// Layering:
//   - PipelinePhases: an interface of pure async functions, one per phase.
//     Phases are individually testable and can be stubbed.
//   - defaultPipelinePhases(): real implementations that delegate to the
//     existing Wave 1/2 modules (composer, post-pass, ledger, critics,
//     revision-loop).
//   - runPipeline(): plain-async-function driver — runs every phase
//     sequentially, captures step logs, and returns a PlanWorkflowResult.
//     This is what the unit tests exercise.
//   - PlannerWorkflow: WorkflowEntrypoint subclass that wraps the same
//     phases inside `step.do()` calls so Cloudflare Workflows handles
//     durability. Wraps runPipeline-style logic but uses step boundaries.
//
// Wave 3A (parallel agent) owns src/mise-graph/revision-loop.ts. We
// `import type` from it via a temporary local declaration until that
// module lands. Real wiring through Wave 3A's `runRevisionLoop` happens
// at integration time.

import type { MiseWeeklyPlanDraft, MisePlanComponentBatch, MisePlanMeal } from "./planner";
import type { ComposerInput, ComposedMenu, ComposerSlotInput, ComposerRawIngredient, ComposerLineageRef } from "./menu-composer";
import type { MiseGraphEnv } from "./types";
import type { Grievance } from "./critics";
import { runHardCritics, runWarningCritics } from "./critics";
import { ledgerFromPlan } from "./resource-ledger";
import {
	WorkflowEntrypointBase,
	type WorkflowEventType,
	type WorkflowStepType,
} from "./__cloudflare-shim";
// Wave 3A types — these now ship as a real module. The runtime call to
// runRevisionLoop is wired through the default phases below.
import type { RevisionLoopOptions, RevisionLoopResult } from "./revision-loop";

// Re-export Wave 3A's types so callers of workflow-runner can use them
// without depending on the revision-loop module directly.
export type { RevisionLoopOptions, RevisionLoopResult };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PlanWorkflowParams {
	plan_request: {
		household_id: string | null;
		start_date: string;
		end_date: string;
		people_default: number;
		ingredients: string[];
		cuisine_direction: string[];
		dietary: string[];
		equipment: string[];
		pantry: string[];
		prompt: string | null;
	};
	options: {
		use_llm_revision: boolean;        // default true
		max_revision_rounds: number;       // default 5
		persist: boolean;                  // default true
		audit_only: boolean;               // default false (audit existing plan, no revise)
	};
}

export interface WorkflowStepLog {
	step_name: string;
	status: "pending" | "running" | "succeeded" | "failed" | "skipped";
	started_at: string;
	ended_at: string | null;
	duration_ms: number | null;
	error?: string;
	output_summary?: Record<string, unknown>;
}

export interface PlanWorkflowResult {
	plan: MiseWeeklyPlanDraft;
	revision: RevisionLoopResult;
	final_grievances_summary: { hard: number; warning: number; preference: number };
	step_logs: WorkflowStepLog[];
	total_duration_ms: number;
}

// Phase functions — separated so they're testable without the Workflow
// runtime. The same phases are invoked from runPipeline() (plain async)
// and from PlannerWorkflow.run() (each wrapped in step.do()).
export interface PipelinePhases {
	assembleContext(env: MiseGraphEnv, params: PlanWorkflowParams): Promise<ComposerInput>;
	initialCompose(env: MiseGraphEnv, input: ComposerInput): Promise<MiseWeeklyPlanDraft>;
	applyToLedger(plan: MiseWeeklyPlanDraft): Promise<MiseWeeklyPlanDraft>;
	audit(plan: MiseWeeklyPlanDraft): Promise<{ plan: MiseWeeklyPlanDraft; grievance_count: number; grievances: Grievance[] }>;
	revise(env: MiseGraphEnv, plan: MiseWeeklyPlanDraft, opts: RevisionLoopOptions): Promise<{ plan: MiseWeeklyPlanDraft; revision: RevisionLoopResult }>;
	polish(plan: MiseWeeklyPlanDraft): Promise<MiseWeeklyPlanDraft>;
	persist(env: MiseGraphEnv, plan: MiseWeeklyPlanDraft): Promise<void>;
}

// ---------------------------------------------------------------------------
// Default phase implementations
// ---------------------------------------------------------------------------

export function defaultPipelinePhases(): PipelinePhases {
	return {
		assembleContext: defaultAssembleContext,
		initialCompose: defaultInitialCompose,
		applyToLedger: defaultApplyToLedger,
		audit: defaultAudit,
		revise: defaultRevise,
		polish: defaultPolish,
		persist: defaultPersist,
	};
}

async function defaultAssembleContext(_env: MiseGraphEnv, params: PlanWorkflowParams): Promise<ComposerInput> {
	const { plan_request: req } = params;
	const slots = buildDefaultSlots(req.start_date, req.end_date, req.people_default);
	return {
		start_date: req.start_date,
		end_date: req.end_date,
		people_default: req.people_default,
		prompt: req.prompt,
		cuisine_direction: req.cuisine_direction,
		anchor_ingredients: req.ingredients,
		pantry: req.pantry,
		equipment: req.equipment,
		household_id: req.household_id,
		dietary: req.dietary,
		slots,
		formulas: [],
		max_active_time_min: null,
		context: null,
		overlapping_inventory: [],
	};
}

// Stub for now. Real wiring runs `composeMenuWithLlm` then converts the
// `ComposedMenu` to a `MiseWeeklyPlanDraft` via the existing planner
// conversion logic. For the first cut, callers pass an injected stub
// composer; integration code will swap in the real composer later.
async function defaultInitialCompose(_env: MiseGraphEnv, input: ComposerInput): Promise<MiseWeeklyPlanDraft> {
	// TODO(integration): wire to composeMenuWithLlm + MiseWeeklyPlanDraft
	// conversion. Until then, return an empty skeleton plan keyed off the
	// composer input so the rest of the pipeline can still run end-to-end
	// with a stubbed phase set in tests.
	return makeEmptyPlanFromInput(input);
}

async function defaultApplyToLedger(plan: MiseWeeklyPlanDraft): Promise<MiseWeeklyPlanDraft> {
	const safePlan: MiseWeeklyPlanDraft = {
		...plan,
		breakfasts: plan.breakfasts || [],
		snack_boxes: plan.snack_boxes || [],
		component_batches: plan.component_batches || [],
		meals_by_day: plan.meals_by_day || [],
	};
	const ledger = ledgerFromPlan(safePlan);
	const endDate = safePlan.end_date || safePlan.start_date;
	const wasteAtEnd = ledger.waste_at_end(endDate);
	const expiringByEnd = ledger.expiring_by(endDate, 1);
	const summary = {
		waste_at_end_count: wasteAtEnd.length,
		expiring_by_end_count: expiringByEnd.length,
	};
	return {
		...safePlan,
		meta: {
			...safePlan.meta,
			ledger_summary: summary,
		},
	};
}

async function defaultAudit(plan: MiseWeeklyPlanDraft): Promise<{ plan: MiseWeeklyPlanDraft; grievance_count: number; grievances: Grievance[] }> {
	const hard = runHardCritics(plan);
	const warning = runWarningCritics(plan);
	const grievances = [...hard, ...warning];
	return { plan, grievance_count: grievances.length, grievances };
}

// Wave 3A's runRevisionLoop is the real entry point. We call it and
// surface its `final_plan` as the chaining `plan` plus the full
// RevisionLoopResult.
async function defaultRevise(_env: MiseGraphEnv, plan: MiseWeeklyPlanDraft, opts: RevisionLoopOptions): Promise<{ plan: MiseWeeklyPlanDraft; revision: RevisionLoopResult }> {
	// Lazy import — keeps workflow-runner agnostic about whether the loop
	// implementation is the real Wave 3A module or a test double.
	const { runRevisionLoop } = await import("./revision-loop");
	const revision = await runRevisionLoop(plan, opts);
	return { plan: revision.final_plan, revision };
}

async function defaultPolish(plan: MiseWeeklyPlanDraft): Promise<MiseWeeklyPlanDraft> {
	// NOOP for the first cut — runRevisionLoop already runs polish internally.
	return plan;
}

async function defaultPersist(_env: MiseGraphEnv, plan: MiseWeeklyPlanDraft): Promise<void> {
	// Stub — real persistence (saveMiseWeeklyPlan) is wired by integration code later.
	console.log(`[mise-workflow] persist stub: plan_id=${plan.id} title=${plan.title}`);
}

// ---------------------------------------------------------------------------
// runPipeline — the test-friendly driver
// ---------------------------------------------------------------------------

const STEP_ORDER = [
	"assemble_context",
	"initial_compose",
	"apply_to_ledger",
	"audit",
	"revise",
	"polish",
	"persist",
] as const;

export async function runPipeline(
	env: MiseGraphEnv,
	params: PlanWorkflowParams,
	phases?: PipelinePhases,
): Promise<PlanWorkflowResult> {
	const ph = phases ?? defaultPipelinePhases();
	const stepLogs: WorkflowStepLog[] = [];
	const overallStart = Date.now();

	const auditOnly = params.options.audit_only === true;

	// 1. assemble_context
	const ctx = await runStep(stepLogs, "assemble_context", async () => {
		const result = await ph.assembleContext(env, params);
		return {
			value: result,
			summary: { slots: result.slots.length, dietary: result.dietary.length },
		};
	});

	// 2. initial_compose
	let plan = await runStep(stepLogs, "initial_compose", async () => {
		const result = await ph.initialCompose(env, ctx);
		return {
			value: result,
			summary: {
				plan_id: result.id,
				meals_by_day: (result.meals_by_day || []).length,
				component_batches: (result.component_batches || []).length,
			},
		};
	});

	// 3. apply_to_ledger
	plan = await runStep(stepLogs, "apply_to_ledger", async () => {
		const result = await ph.applyToLedger(plan);
		return {
			value: result,
			summary: { ledger_summary: (result.meta as Record<string, unknown>)?.ledger_summary as Record<string, unknown> | undefined },
		};
	});

	// 4. audit
	const auditOut = await runStep(stepLogs, "audit", async () => {
		const result = await ph.audit(plan);
		const summary = grievanceSummary(result.grievances);
		return {
			value: result,
			summary: { grievance_count: result.grievance_count, ...summary },
		};
	});
	plan = auditOut.plan;

	// 5. revise — skipped if audit_only.
	let revision: RevisionLoopResult;
	if (auditOnly) {
		stepLogs.push(skippedLog("revise"));
		revision = makeAuditOnlyRevisionResult(plan, auditOut.grievances);
	} else {
		const revisionOpts: RevisionLoopOptions = {
			max_rounds: params.options.max_revision_rounds,
			use_llm_for_alternatives: params.options.use_llm_revision,
		};
		const reviseOut = await runStep(stepLogs, "revise", async () => {
			const result = await ph.revise(env, plan, revisionOpts);
			return {
				value: result,
				summary: {
					rounds: result.revision.rounds.length,
					final_grievances: result.revision.final_grievances.length,
				},
			};
		});
		plan = reviseOut.plan;
		revision = reviseOut.revision;
	}

	// 6. polish — skipped if audit_only.
	if (auditOnly) {
		stepLogs.push(skippedLog("polish"));
	} else {
		plan = await runStep(stepLogs, "polish", async () => {
			const result = await ph.polish(plan);
			return { value: result, summary: { plan_id: result.id } };
		});
	}

	// 7. persist
	await runStep(stepLogs, "persist", async () => {
		await ph.persist(env, plan);
		return { value: undefined, summary: { persisted: params.options.persist === true } };
	});

	const final_grievances_summary = grievanceSummary(revision.final_grievances);

	return {
		plan,
		revision,
		final_grievances_summary,
		step_logs: stepLogs,
		total_duration_ms: Math.max(1, Date.now() - overallStart),
	};
}

// ---------------------------------------------------------------------------
// PlannerWorkflow — Cloudflare Workflows entrypoint.
// ---------------------------------------------------------------------------

export class PlannerWorkflow extends WorkflowEntrypointBase<MiseGraphEnv, PlanWorkflowParams> {
	private phases: PipelinePhases = defaultPipelinePhases();

	async run(event: WorkflowEventType<PlanWorkflowParams>, step: WorkflowStepType): Promise<PlanWorkflowResult> {
		const params = event.payload as PlanWorkflowParams;
		const overallStart = Date.now();
		const stepLogs: WorkflowStepLog[] = [];
		const auditOnly = params.options.audit_only === true;

		// stepDo: thin wrapper around step.do that bypasses the strict
		// `Rpc.Serializable<T>` constraint on the callback's return type.
		// Our domain types (MiseWeeklyPlanDraft etc.) are JSON-serializable
		// at runtime — the constraint is overzealous here.
		const stepDo = async <R>(
			name: string,
			body: () => Promise<R>,
			config?: { retries?: { limit: number; delay: number; backoff?: "constant" | "linear" | "exponential" } },
		): Promise<R> => {
			const wrapped = (async () => {
				return wrap(stepLogs, name, body);
			}) as unknown as (ctx: { attempt: number }) => Promise<unknown> & { __brand?: never };
			// Cast `step` to a relaxed signature — Cloudflare's
			// `Rpc.Serializable<T>` constraint is overzealous for our
			// JSON-shaped domain types.
			const relaxed = step as unknown as {
				do<T>(name: string, callback: (ctx: { attempt: number }) => Promise<T>): Promise<T>;
				do<T>(name: string, config: unknown, callback: (ctx: { attempt: number }) => Promise<T>): Promise<T>;
			};
			const result = config
				? await relaxed.do<R>(name, config, wrapped as (ctx: { attempt: number }) => Promise<R>)
				: await relaxed.do<R>(name, wrapped as (ctx: { attempt: number }) => Promise<R>);
			return result;
		};

		// Each step is a checkpointable boundary. Cloudflare Workflows
		// memoizes step outputs and replays from the failed step on retry.
		const ctx = await stepDo("assemble_context", () => this.phases.assembleContext(this.env, params));

		let plan: MiseWeeklyPlanDraft = await stepDo(
			"initial_compose",
			() => this.phases.initialCompose(this.env, ctx),
			{ retries: { limit: 2, delay: 1000, backoff: "exponential" } },
		);

		plan = await stepDo("apply_to_ledger", () => this.phases.applyToLedger(plan));

		const auditResult = await stepDo("audit", () => this.phases.audit(plan));
		plan = auditResult.plan;

		let revision: RevisionLoopResult;
		if (auditOnly) {
			stepLogs.push(skippedLog("revise"));
			stepLogs.push(skippedLog("polish"));
			revision = makeAuditOnlyRevisionResult(plan, auditResult.grievances);
		} else {
			const revisionOpts: RevisionLoopOptions = {
				max_rounds: params.options.max_revision_rounds,
				use_llm_for_alternatives: params.options.use_llm_revision,
			};
			const reviseOut = await stepDo(
				"revise",
				() => this.phases.revise(this.env, plan, revisionOpts),
				{ retries: { limit: 1, delay: 2000, backoff: "exponential" } },
			);
			plan = reviseOut.plan;
			revision = reviseOut.revision;

			plan = await stepDo("polish", () => this.phases.polish(plan));
		}

		await stepDo("persist", async () => {
			await this.phases.persist(this.env, plan);
			return { ok: true };
		});

		return {
			plan,
			revision,
			final_grievances_summary: grievanceSummary(revision.final_grievances),
			step_logs: stepLogs,
			total_duration_ms: Math.max(1, Date.now() - overallStart),
		};
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RunStepReturn<T> {
	value: T;
	summary?: Record<string, unknown>;
}

async function runStep<T>(
	logs: WorkflowStepLog[],
	stepName: string,
	body: () => Promise<RunStepReturn<T>>,
): Promise<T> {
	const startedAt = new Date().toISOString();
	const t0 = Date.now();
	const log: WorkflowStepLog = {
		step_name: stepName,
		status: "running",
		started_at: startedAt,
		ended_at: null,
		duration_ms: null,
	};
	logs.push(log);
	try {
		const { value, summary } = await body();
		log.status = "succeeded";
		log.ended_at = new Date().toISOString();
		log.duration_ms = Math.max(1, Date.now() - t0);
		if (summary) log.output_summary = summary;
		return value;
	} catch (err) {
		log.status = "failed";
		log.ended_at = new Date().toISOString();
		log.duration_ms = Math.max(1, Date.now() - t0);
		log.error = err instanceof Error ? err.message : String(err);
		throw err;
	}
}

// Used by PlannerWorkflow steps to capture log entries inside a step.do()
// body. Returns the underlying value (so step.do still memoizes it).
async function wrap<T>(logs: WorkflowStepLog[], stepName: string, body: () => Promise<T>): Promise<T> {
	const startedAt = new Date().toISOString();
	const t0 = Date.now();
	const log: WorkflowStepLog = {
		step_name: stepName,
		status: "running",
		started_at: startedAt,
		ended_at: null,
		duration_ms: null,
	};
	logs.push(log);
	try {
		const value = await body();
		log.status = "succeeded";
		log.ended_at = new Date().toISOString();
		log.duration_ms = Math.max(1, Date.now() - t0);
		return value;
	} catch (err) {
		log.status = "failed";
		log.ended_at = new Date().toISOString();
		log.duration_ms = Math.max(1, Date.now() - t0);
		log.error = err instanceof Error ? err.message : String(err);
		throw err;
	}
}

function skippedLog(stepName: string): WorkflowStepLog {
	const now = new Date().toISOString();
	return {
		step_name: stepName,
		status: "skipped",
		started_at: now,
		ended_at: now,
		duration_ms: 0,
	};
}

function grievanceSummary(grievances: Grievance[]): { hard: number; warning: number; preference: number } {
	const out = { hard: 0, warning: 0, preference: 0 };
	for (const g of grievances) {
		if (g.severity === "hard") out.hard++;
		else if (g.severity === "warning") out.warning++;
		else if (g.severity === "preference") out.preference++;
	}
	return out;
}

// Synthetic RevisionLoopResult for audit-only mode — the loop didn't run,
// so we surface the audit-phase grievances as both initial + final.
function makeAuditOnlyRevisionResult(plan: MiseWeeklyPlanDraft, grievances: Grievance[]): RevisionLoopResult {
	const summary = grievanceSummary(grievances);
	return {
		final_plan: plan,
		initial_grievances: grievances,
		final_grievances: grievances,
		rounds: [],
		polish_moves: [],
		converged: summary.hard === 0,
		budget_exhausted: false,
		total_duration_ms: 0,
		summary: {
			initial_hard: summary.hard,
			initial_soft: summary.warning + summary.preference,
			final_hard: summary.hard,
			final_soft: summary.warning + summary.preference,
			rounds_run: 0,
			total_attempts: 0,
			total_committed: 0,
			polish_moves_applied: 0,
		},
	};
}

// Build a default per-day slot list (breakfast + lunch + dinner) covering
// [start_date, end_date]. People_default fills the per-slot people count.
function buildDefaultSlots(startDate: string, endDate: string, peopleDefault: number): ComposerSlotInput[] {
	const slots: ComposerSlotInput[] = [];
	const start = new Date(startDate + "T00:00:00Z");
	const end = new Date(endDate + "T00:00:00Z");
	if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return slots;
	for (let d = new Date(start); d.getTime() <= end.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
		const date = d.toISOString().slice(0, 10);
		for (const slot of ["breakfast", "lunch", "dinner"] as const) {
			slots.push({
				date,
				slot,
				people: peopleDefault,
				cuisine: [],
				format: null,
				title_hint: null,
				locked: false,
				notes: [],
			});
		}
	}
	return slots;
}

// Empty-skeleton plan keyed off the composer input. Used only when no
// real composer is wired (default phases). Stub composer in tests should
// override this.
function makeEmptyPlanFromInput(input: ComposerInput): MiseWeeklyPlanDraft {
	return {
		id: `mise_plan:${input.start_date}:${input.end_date}`,
		household_id: input.household_id ?? null,
		title: `Mise plan ${input.start_date} to ${input.end_date}`,
		start_date: input.start_date,
		end_date: input.end_date,
		timezone: null,
		people: input.people_default,
		status: "draft",
		constraints: {},
		selected_ingredients: input.anchor_ingredients,
		source_recipe_ids: [],
		meals_by_day: [],
		component_batches: [],
		prep_tasks: [],
		breakfasts: [],
		snack_boxes: [],
		shopping_list: [],
		storage_labels: [],
		meta: {
			generated_by: "mise_graph_planner",
			deterministic: false,
		},
	};
}

// Re-exported helpers (for tests that want to simulate phases). Kept as
// local types so this module stays self-contained.
export type { ComposerInput, ComposedMenu, ComposerRawIngredient, ComposerLineageRef };
export type { MiseWeeklyPlanDraft, MisePlanComponentBatch, MisePlanMeal };
