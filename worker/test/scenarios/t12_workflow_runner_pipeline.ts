// T12 — runPipeline drives all 7 phases through stub PipelinePhases.
//
// Verifies:
//   - All 7 step logs are captured in correct order
//   - Each log has status, started_at, ended_at, duration_ms
//   - The plan returned matches the polish-phase output (last in chain)
//   - The revision result is the stub's RevisionLoopResult
//   - total_duration_ms > 0
//
// Audit-only mode:
//   - Same stub, options.audit_only = true
//   - revise + polish are recorded as "skipped"
//   - Only 5 phases actually run, but step_logs has 7 entries (5 succeeded
//     + 2 skipped) so callers get a uniform shape.
//
// No real LLM, no real bridge — all phases are stubbed.

import type { Scenario } from "../lib/types";
import {
	runPipeline,
	type PlanWorkflowParams,
	type PipelinePhases,
	type RevisionLoopResult,
	type RevisionLoopOptions,
} from "../../src/mise-graph/workflow-runner";
import type { MiseWeeklyPlanDraft } from "../../src/mise-graph/planner";
import type { ComposerInput } from "../../src/mise-graph/menu-composer";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

function makeStubPlan(idSuffix: string): MiseWeeklyPlanDraft {
	return {
		id: `plan:${idSuffix}`,
		household_id: null,
		title: `stub plan ${idSuffix}`,
		start_date: "2026-05-11",
		end_date: "2026-05-17",
		timezone: null,
		people: 2,
		status: "draft",
		constraints: {},
		selected_ingredients: [],
		source_recipe_ids: [],
		meals_by_day: [],
		component_batches: [],
		prep_tasks: [],
		breakfasts: [],
		snack_boxes: [],
		shopping_list: [],
		storage_labels: [],
		meta: { generated_by: "mise_graph_planner", deterministic: true },
	};
}

function makeStubPhases(): { phases: PipelinePhases; calls: string[]; revisionResult: RevisionLoopResult } {
	const calls: string[] = [];
	const composedPlan = makeStubPlan("composed");
	const ledgeredPlan: MiseWeeklyPlanDraft = {
		...composedPlan,
		id: "plan:ledgered",
		meta: { ...composedPlan.meta, ledger_summary: { waste_at_end_count: 0, expiring_by_end_count: 0 } },
	};
	const auditedPlan: MiseWeeklyPlanDraft = { ...ledgeredPlan, id: "plan:audited" };
	const revisedPlan: MiseWeeklyPlanDraft = { ...auditedPlan, id: "plan:revised" };
	const polishedPlan: MiseWeeklyPlanDraft = { ...revisedPlan, id: "plan:polished" };

	const revisionResult: RevisionLoopResult = {
		final_plan: revisedPlan,
		initial_grievances: [],
		final_grievances: [],
		rounds: [],
		polish_moves: [],
		converged: true,
		budget_exhausted: false,
		total_duration_ms: 1,
		summary: {
			initial_hard: 0,
			initial_soft: 0,
			final_hard: 0,
			final_soft: 0,
			rounds_run: 2,
			total_attempts: 3,
			total_committed: 2,
			polish_moves_applied: 0,
		},
	};

	const phases: PipelinePhases = {
		async assembleContext(_env: MiseGraphEnv, params: PlanWorkflowParams): Promise<ComposerInput> {
			calls.push("assembleContext");
			return {
				start_date: params.plan_request.start_date,
				end_date: params.plan_request.end_date,
				people_default: params.plan_request.people_default,
				prompt: params.plan_request.prompt,
				cuisine_direction: params.plan_request.cuisine_direction,
				anchor_ingredients: params.plan_request.ingredients,
				pantry: params.plan_request.pantry,
				equipment: params.plan_request.equipment,
				household_id: params.plan_request.household_id,
				dietary: params.plan_request.dietary,
				slots: [],
				formulas: [],
				max_active_time_min: null,
				context: null,
				overlapping_inventory: [],
			};
		},
		async initialCompose() {
			calls.push("initialCompose");
			return composedPlan;
		},
		async applyToLedger() {
			calls.push("applyToLedger");
			return ledgeredPlan;
		},
		async audit(plan) {
			calls.push("audit");
			return { plan: { ...plan, id: "plan:audited" }, grievance_count: 0, grievances: [] };
		},
		async revise(_env: MiseGraphEnv, _plan: MiseWeeklyPlanDraft, _opts: RevisionLoopOptions) {
			calls.push("revise");
			return { plan: revisedPlan, revision: revisionResult };
		},
		async polish() {
			calls.push("polish");
			return polishedPlan;
		},
		async persist() {
			calls.push("persist");
		},
	};

	return { phases, calls, revisionResult };
}

const stubEnv: MiseGraphEnv = { DB: {} as D1Database };

const stubParams: PlanWorkflowParams = {
	plan_request: {
		household_id: null,
		start_date: "2026-05-11",
		end_date: "2026-05-17",
		people_default: 2,
		ingredients: [],
		cuisine_direction: [],
		dietary: [],
		equipment: [],
		pantry: [],
		prompt: null,
	},
	options: {
		use_llm_revision: true,
		max_revision_rounds: 5,
		persist: true,
		audit_only: false,
	},
};

const t12: Scenario = {
	id: "t12",
	name: "runPipeline drives all 7 phases via stubbed PipelinePhases",
	group: "integration",
	tier: "fast",
	async run(ctx) {
		// Tiny pause so total_duration_ms > 0 even on very fast machines.
		await new Promise(r => setTimeout(r, 1));

		// 1. Full pipeline (audit_only = false): all 7 phases run.
		const { phases, calls, revisionResult } = makeStubPhases();
		const result = await runPipeline(stubEnv, stubParams, phases);

		ctx.assert.eq(result.step_logs.length, 7, "all 7 step logs captured");

		const expectedOrder = [
			"assemble_context",
			"initial_compose",
			"apply_to_ledger",
			"audit",
			"revise",
			"polish",
			"persist",
		];
		for (let i = 0; i < expectedOrder.length; i++) {
			ctx.assert.eq(result.step_logs[i].step_name, expectedOrder[i],
				`step_logs[${i}].step_name == ${expectedOrder[i]}`);
			ctx.assert.eq(result.step_logs[i].status, "succeeded",
				`step_logs[${i}].status == succeeded`);
			ctx.assert.gte(result.step_logs[i].duration_ms ?? 0, 1,
				`step_logs[${i}].duration_ms >= 1ms`);
			ctx.assert.ok(typeof result.step_logs[i].started_at === "string" && result.step_logs[i].started_at.length > 0,
				`step_logs[${i}].started_at is set`);
			ctx.assert.ok(typeof result.step_logs[i].ended_at === "string" && (result.step_logs[i].ended_at?.length ?? 0) > 0,
				`step_logs[${i}].ended_at is set`);
		}

		ctx.assert.eq(calls.length, 7, "all 7 phase functions invoked");
		ctx.assert.eq(result.plan.id, "plan:polished", "result.plan is polish-phase output");
		ctx.assert.eq(result.revision, revisionResult, "result.revision === stub RevisionLoopResult");
		ctx.assert.gt(result.total_duration_ms, 0, "total_duration_ms > 0");
		ctx.assert.eq(result.final_grievances_summary.hard, 0, "no hard grievances in final summary");

		ctx.notes.push(`full pipeline: ${calls.join(" → ")}`);
		ctx.notes.push(`total_duration_ms = ${result.total_duration_ms}`);

		// 2. Audit-only mode: revise + polish skipped.
		const { phases: phases2, calls: calls2 } = makeStubPhases();
		const auditOnlyParams: PlanWorkflowParams = {
			...stubParams,
			options: { ...stubParams.options, audit_only: true },
		};
		const auditOnlyResult = await runPipeline(stubEnv, auditOnlyParams, phases2);

		ctx.assert.eq(auditOnlyResult.step_logs.length, 7,
			"audit-only mode still emits 7 step logs (5 succeeded + 2 skipped)");

		const reviseLog = auditOnlyResult.step_logs.find(l => l.step_name === "revise");
		ctx.assert.ok(!!reviseLog, "revise log entry present");
		ctx.assert.eq(reviseLog?.status, "skipped", "revise step is skipped in audit-only mode");

		const polishLog = auditOnlyResult.step_logs.find(l => l.step_name === "polish");
		ctx.assert.ok(!!polishLog, "polish log entry present");
		ctx.assert.eq(polishLog?.status, "skipped", "polish step is skipped in audit-only mode");

		const successLogs = auditOnlyResult.step_logs.filter(l => l.status === "succeeded");
		ctx.assert.eq(successLogs.length, 5, "exactly 5 succeeded steps in audit-only mode");

		// Calls: assembleContext, initialCompose, applyToLedger, audit, persist (no revise/polish)
		ctx.assert.eq(calls2.length, 5, "audit-only invokes only 5 phase functions");
		ctx.assert.ok(!calls2.includes("revise"), "revise phase NOT called in audit-only");
		ctx.assert.ok(!calls2.includes("polish"), "polish phase NOT called in audit-only");

		ctx.notes.push(`audit-only pipeline: ${calls2.join(" → ")}`);
	},
};

export default t12;
