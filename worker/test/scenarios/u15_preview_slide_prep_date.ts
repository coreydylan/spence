// U15 — previewSlidePrepDate unit tests.
//
// Verifies that previewSlidePrepDate:
//   1. Sliding a batch's prep date AFTER the meal date violates min_lead_time
//      (an idle/ferment edge becomes infeasible).
//   2. Sliding the prep date closer to the first use (still respecting idle
//      time) introduces no new violations.
//   3. Updates the prep_task's scheduled_date and the batch's
//      meta.desired_prep_date.
//   4. Missing batch and locked-batch fast paths return warnings.

import type { Scenario } from "../lib/types";
import {
	previewSlidePrepDate,
	commit,
	clearProposalCache,
} from "../../src/mise-graph/ripple-preview";
import type {
	MiseWeeklyPlanDraft,
	MisePlanMeal,
	MisePlanComponentBatch,
	MisePlanTask,
} from "../../src/mise-graph/planner";

const u15: Scenario = {
	id: "u15",
	name: "previewSlidePrepDate captures min_lead_time violations and clean slides via dependency-edge diff",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// --- Path 1: slide LATER (after meal) violates min_lead_time -----------
		clearProposalCache();
		let plan = makePlan({ prepDate: "2026-05-12", locked: false });
		// Meal date = 2026-05-15, idle = 24h. Sliding prep to 2026-05-15 means
		// 0h lead → violates min_lead_time(24h).
		const tooLate = previewSlidePrepDate(plan, "mise_component:dough", "2026-05-15");

		ctx.notes.push(`tooLate warnings: ${tooLate.warnings.length}`);
		ctx.notes.push(`tooLate edges added/removed/changed: ${tooLate.affected_edges.added.length}/${tooLate.affected_edges.removed.length}/${tooLate.affected_edges.status_changed.length}`);
		ctx.notes.push(`tooLate new_grievances: ${tooLate.new_grievances.length}`);

		ctx.assert.eq(tooLate.warnings.length, 0, "valid slide produces no warnings");

		// A min_lead_time edge should now be violated. Either it appears in
		// status_changed (status flipped to "violated") or in new_grievances
		// from the EdgeViolationCritic.
		const newViolations = tooLate.new_grievances.filter(g => g.critic === "EdgeViolationCritic");
		const minLeadStatusChange = tooLate.affected_edges.status_changed.find(e =>
			e.rule.kind === "min_lead_time" && e.status === "violated");

		ctx.assert.ok(newViolations.length > 0 || !!minLeadStatusChange,
			"sliding past meal date introduces a min_lead_time violation (in grievances or edge status)");

		// Post-state: batch's desired_prep_date and prep_task's scheduled_date both updated.
		const post = tooLate.preview_state!.plan;
		const batch = post.component_batches.find(b => b.id === "mise_component:dough")!;
		ctx.assert.eq((batch.meta as Record<string, unknown>).desired_prep_date, "2026-05-15",
			"batch's desired_prep_date is updated");
		const prepTask = post.prep_tasks.find(t => t.state_outputs.includes("mise_component:dough"))!;
		ctx.assert.eq(prepTask.scheduled_date, "2026-05-15", "prep_task's scheduled_date is updated");

		// commit returns post-state.
		const committed = commit(plan, tooLate.proposal_id);
		const committedBatch = committed.component_batches.find(b => b.id === "mise_component:dough")!;
		ctx.assert.eq((committedBatch.meta as Record<string, unknown>).desired_prep_date, "2026-05-15",
			"commit returns post-state with new prep date");

		// --- Path 2: slide CLOSER (still satisfies idle) introduces no new violations.
		// Original prep is T-3 days early (5/12 → 5/15 = 72h lead). Slide to T-1
		// (5/14 → 5/15 = 24h lead), which still meets the 24h idle requirement.
		clearProposalCache();
		plan = makePlan({ prepDate: "2026-05-12", locked: false });
		const closer = previewSlidePrepDate(plan, "mise_component:dough", "2026-05-14");
		ctx.notes.push(`closer new_grievances: ${closer.new_grievances.length}`);
		ctx.notes.push(`closer resolved_grievances: ${closer.resolved_grievances.length}`);
		const closerNewHard = closer.new_grievances.filter(g => g.severity === "hard");
		ctx.assert.eq(closerNewHard.length, 0, "sliding closer (still respecting idle) introduces no new hard grievances");

		// --- Path 3: missing batch ----------------------------------------------
		clearProposalCache();
		plan = makePlan({ prepDate: "2026-05-12", locked: false });
		const missing = previewSlidePrepDate(plan, "no_such_batch", "2026-05-13");
		ctx.assert.gt(missing.warnings.length, 0, "missing batch produces a warning");
		ctx.assert.contains(missing.warnings.join(" "), "not found", "warning mentions 'not found'");

		// --- Path 4: locked batch -----------------------------------------------
		clearProposalCache();
		plan = makePlan({ prepDate: "2026-05-12", locked: true });
		const blocked = previewSlidePrepDate(plan, "mise_component:dough", "2026-05-14");
		ctx.assert.gt(blocked.warnings.length, 0, "locked batch produces a warning");
		ctx.assert.matches(blocked.warnings.join(" "), /lock/i, "warning mentions lock");
	},
};

// ---------------------------------------------------------------------------
// Fixture: a "dough" batch that needs 24h idle (cold ferment) before serving.
// Quality window = 96h (4 days). One planned use on 2026-05-15.
// ---------------------------------------------------------------------------

function makePlan(opts: { prepDate: string; locked: boolean }): MiseWeeklyPlanDraft {
	const friMeal: MisePlanMeal = {
		id: "meal:fri_dinner",
		date: "2026-05-15",
		slot: "dinner",
		title: "Pizza Night",
		format: "pizza",
		component_ids: ["mise_component:dough"],
		ingredient_names: [],
		source: "synthetic_test",
		notes: [],
		people: 2,
		cuisine: ["italian"],
		locked: false,
	};

	const batch: MisePlanComponentBatch = {
		id: "mise_component:dough",
		state_id: null,
		label: "Cold-Ferment Dough",
		quantity: 600,
		unit: "g",
		storage: "refrigerator",
		container: null,
		quality_window_hours: 96,
		planned_uses: [{
			date: "2026-05-15",
			slot: "dinner",
			meal_id: "meal:fri_dinner",
			title: "Pizza Night",
		}],
		station_tags: ["bake_active"],
		equipment: ["stand mixer"],
		active_time_min: 20,
		idle_time_min: 24 * 60,    // 24h ferment
		input_names: ["flour", "yeast", "salt", "olive oil"],
		meta: {
			source: "synthetic_test",
			desired_prep_date: opts.prepDate,
			...(opts.locked ? { lock: { locked: true, lock_reason: "user pin", locked_at: "2026-05-01T00:00:00Z" } } : {}),
		},
	};

	const prepTask: MisePlanTask = {
		id: "task:dough_prep",
		scheduled_date: opts.prepDate,
		session_order: 0,
		task_type: "component_prep",
		title: "Mix dough + cold ferment",
		station_tags: ["bake_active"],
		equipment: ["stand mixer"],
		depends_on: [],
		state_inputs: [],
		state_outputs: ["mise_component:dough"],
		active_time_min: 20,
		idle_time_min: 24 * 60,
		instructions: ["Mix dough", "Cold ferment 24h"],
		status: "planned",
		meta: {},
	};

	return {
		id: "mise_plan:u15",
		household_id: "test",
		title: "U15 fixture",
		start_date: "2026-05-11",
		end_date: "2026-05-17",
		timezone: "UTC",
		people: 2,
		status: "draft",
		constraints: {},
		selected_ingredients: [],
		source_recipe_ids: [],
		meals_by_day: [
			{ date: "2026-05-15", day_index: 4, meals: [friMeal] },
		],
		component_batches: [batch],
		prep_tasks: [prepTask],
		breakfasts: [],
		snack_boxes: [],
		shopping_list: [],
		shop_runs: [],
		storage_labels: [],
		meta: { generated_by: "mise_graph_planner", deterministic: true },
	};
}

export default u15;
