// T14 - PlanWorld tool loop catches and fixes a too-early dough use.
//
// This stays fully in-memory: read the world, preview a slide_prep_date fix,
// commit the proposal, then finalize and verify hard grievances decreased.

import type { Scenario } from "../lib/types";
import type {
	MisePlanComponentBatch,
	MisePlanMeal,
	MisePlanTask,
	MiseWeeklyPlanDraft,
} from "../../src/mise-graph/planner";
import { clearProposalCache } from "../../src/mise-graph/ripple-preview";
import {
	createPlanWorld,
	planCommitPreview,
	planFinalize,
	planReadCoherence,
	planPreviewMutation,
	planReadGrievances,
	planReadMap,
	planReadMeal,
	planReadSummary,
} from "../../src/mise-graph/plan-world-tools";

const t14: Scenario = {
	id: "t14",
	name: "PlanWorld read-preview-commit loop fixes too-early dough use",
	group: "integration",
	tier: "fast",
	async run(ctx) {
		clearProposalCache();
		const brokenPlan = buildTooEarlyDoughPlan();
		let world = createPlanWorld(brokenPlan);

		const initialSummary = planReadSummary(world);
		const initialMeal = planReadMeal(world, { date: "2026-05-16", slot: "dinner" });
		const initialGrievances = planReadGrievances(world);
		const initialCoherence = planReadCoherence(world);
		const initialMap = planReadMap(world);
		const initialHard = initialGrievances.counts.hard;

		ctx.notes.push(`initial hard grievances: ${initialHard}`);
		ctx.notes.push(`initial coherence score: ${initialCoherence.score}`);
		ctx.notes.push(`initial empty slots: ${initialSummary.empty_slot_count}`);
		for (const grievance of initialGrievances.grievances) {
			ctx.notes.push(`${grievance.critic}: ${grievance.message.slice(0, 90)}`);
		}

		ctx.assert.eq(initialMeal.found, true, "tool read finds Saturday dinner");
		ctx.assert.eq(initialMeal.meal?.title, "Cold-Ferment Pizza Night", "meal read returns the broken target meal");
		ctx.assert.gt(initialHard, 0, "broken plan starts with at least one hard grievance");
		ctx.assert.gt(initialSummary.coherence_score, 0, "summary includes non-zero initial coherence score");
		ctx.assert.contains(initialMap, "## Coherence Score", "map read includes coherence score section");
		ctx.assert.contains(initialMap, "dependency_edge_violations", "map read exposes edge violations as coherence issues");
		ctx.assert.gt(
			initialGrievances.grievances.filter(g => g.critic === "EdgeViolationCritic").length,
			0,
			"too-early dough use is caught by dependency-edge critic",
		);

		const preview = planPreviewMutation(world, {
			kind: "slide_prep_date",
			batch_id: "mise_component:slow_dough",
			new_prep_date: "2026-05-14",
		});

		const previewResolvedHard = preview.resolved_grievances.filter(g => g.severity === "hard").length;
		const previewNewHard = preview.new_grievances.filter(g => g.severity === "hard").length;
		ctx.notes.push(`preview resolved hard: ${previewResolvedHard}`);
		ctx.notes.push(`preview new hard: ${previewNewHard}`);
		ctx.notes.push(`preview prep task deltas: ${preview.affected_prep_tasks.length}`);

		ctx.assert.eq(preview.warnings.length, 0, "valid PlanWorld preview has no warnings");
		ctx.assert.gt(previewResolvedHard, 0, "preview resolves at least one hard grievance");
		ctx.assert.eq(previewNewHard, 0, "preview does not introduce a new hard grievance");
		ctx.assert.ok(
			preview.affected_prep_tasks.some(delta =>
				delta.task_id === "task:slow_dough"
				&& delta.change === "moved"
				&& delta.after?.scheduled_date === "2026-05-14"),
			"preview surfaces moved dough prep task",
		);

		const commitResult = planCommitPreview(world, preview.proposal_id);
		world = commitResult.world;

		const committedBatch = world.plan.component_batches.find(batch => batch.id === "mise_component:slow_dough");
		const committedTask = world.plan.prep_tasks.find(task => task.id === "task:slow_dough");
		ctx.assert.eq(
			committedBatch?.meta.desired_prep_date,
			"2026-05-14",
			"commit updates batch desired_prep_date",
		);
		ctx.assert.eq(
			committedTask?.scheduled_date,
			"2026-05-14",
			"commit updates prep task scheduled_date",
		);
		ctx.assert.eq(
			brokenPlan.prep_tasks.find(task => task.id === "task:slow_dough")?.scheduled_date,
			"2026-05-16",
			"original caller plan remains unchanged",
		);

		const final = planFinalize(world);
		const finalHard = final.grievances.counts.hard;
		ctx.notes.push(`final hard grievances: ${finalHard}`);
		ctx.notes.push(`final coherence score: ${final.coherence.score}`);
		ctx.notes.push(`final ok: ${final.ok}`);

		ctx.assert.ok(finalHard < initialHard, "final hard grievance count decreases after commit");
		ctx.assert.ok(final.coherence.score < initialCoherence.score, "final coherence score decreases after commit");
		ctx.assert.eq(final.summary.coherence_score, 0, "final summary is coherence-clean");
		ctx.assert.eq(final.ok, true, "finalized world is hard-grievance clean");
		ctx.assert.eq(
			final.grievances.grievances.filter(g => g.critic === "EdgeViolationCritic").length,
			0,
			"dependency-edge grievance is gone after sliding prep earlier",
		);
	},
};

function buildTooEarlyDoughPlan(): MiseWeeklyPlanDraft {
	const meal: MisePlanMeal = {
		id: "meal:sat_dinner_pizza",
		date: "2026-05-16",
		slot: "dinner",
		title: "Cold-Ferment Pizza Night",
		format: "pizza",
		component_ids: ["mise_component:slow_dough"],
		ingredient_names: [],
		source: "synthetic_test",
		notes: [],
		people: 2,
		cuisine: ["italian"],
		locked: false,
	};

	const batch: MisePlanComponentBatch = {
		id: "mise_component:slow_dough",
		state_id: null,
		label: "48h Cold-Ferment Dough",
		quantity: 600,
		unit: "g",
		storage: "refrigerator",
		container: null,
		quality_window_hours: 120,
		planned_uses: [{
			date: "2026-05-16",
			slot: "dinner",
			meal_id: "meal:sat_dinner_pizza",
			title: "Cold-Ferment Pizza Night",
		}],
		station_tags: ["bake_active"],
		equipment: ["stand mixer"],
		active_time_min: 25,
		idle_time_min: 48 * 60,
		input_names: [],
		meta: {
			source: "synthetic_test",
			desired_prep_date: "2026-05-16",
		},
	};

	const task: MisePlanTask = {
		id: "task:slow_dough",
		scheduled_date: "2026-05-16",
		session_order: 0,
		task_type: "component_prep",
		title: "Mix dough plus 48h cold ferment",
		station_tags: ["bake_active"],
		equipment: ["stand mixer"],
		depends_on: [],
		state_inputs: [],
		state_outputs: ["mise_component:slow_dough"],
		active_time_min: 25,
		idle_time_min: 48 * 60,
		instructions: ["Mix dough", "Cold ferment 48h"],
		status: "planned",
		meta: {},
	};

	return {
		id: "mise_plan:t14",
		household_id: "test",
		title: "T14 PlanWorld fixture",
		start_date: "2026-05-11",
		end_date: "2026-05-17",
		timezone: "UTC",
		people: 2,
		status: "draft",
		constraints: {},
		selected_ingredients: [],
		source_recipe_ids: [],
		meals_by_day: [
			{ date: "2026-05-16", day_index: 5, meals: [meal] },
		],
		component_batches: [batch],
		prep_tasks: [task],
		breakfasts: [],
		snack_boxes: [],
		shopping_list: [],
		shop_runs: [],
		storage_labels: [],
		meta: { generated_by: "mise_graph_planner", deterministic: true },
	};
}

export default t14;
