// T17 - persisted PlanWorld preview/commit state.
//
// The important production behavior is that preview does not mutate plan_json,
// while commit can still apply a stored preview even when the in-memory
// RipplePreview cache is gone.

import type { Scenario } from "../lib/types";
import { callPlanWorldTool } from "../../src/mise-graph/plan-world-mcp";
import { clearProposalCache } from "../../src/mise-graph/ripple-preview";
import type {
	MisePlanComponentBatch,
	MisePlanMeal,
	MisePlanTask,
	MiseWeeklyPlanDraft,
} from "../../src/mise-graph/planner";

const t17: Scenario = {
	id: "t17",
	name: "PlanWorld preview stores draft and commit persists across cache reset",
	group: "integration",
	tier: "fast",
	async run(ctx) {
		clearProposalCache();
		const db = new FakeD1();
		const env = { DB: db as unknown as D1Database } as any;
		const plan = makeTooEarlyDoughPlan();

		const created = await callPlanWorldTool("plan_create", { plan }, env);
		ctx.assert.eq(created.summary?.plan_id, plan.id, "plan_create persists and summarizes plan");

		const before = await callPlanWorldTool("plan_read_summary", { plan_id: plan.id }, env);
		ctx.assert.gt(Number(before.summary?.grievance_counts?.hard || 0), 0, "initial persisted plan has hard grievance");
		ctx.assert.gt(Number(before.summary?.coherence_score || 0), 0, "initial persisted plan has coherence issue");

		const preview = await callPlanWorldTool("plan_preview_mutation", {
			plan_id: plan.id,
			mutation: {
				kind: "slide_prep_date",
				batch_id: "batch:slow_dough",
				new_prep_date: "2026-06-04",
			},
		}, env);
		const proposalId = String((preview.preview as any).proposal_id);
		ctx.assert.ok(proposalId.length > 0, "preview returns proposal id");
		ctx.assert.gt((preview.preview as any).resolved_grievances.length, 0, "preview resolves grievance");
		ctx.assert.eq(db.proposals.get(proposalId)?.status, "draft", "preview stores draft proposal");

		const persistedAfterPreview = db.readPlan(plan.id);
		ctx.assert.eq(
			persistedAfterPreview.prep_tasks.find(task => task.id === "task:slow_dough")?.scheduled_date,
			"2026-06-06",
			"preview does not mutate persisted plan_json",
		);

		clearProposalCache();
		const committed = await callPlanWorldTool("plan_commit_preview", {
			plan_id: plan.id,
			proposal_id: proposalId,
		}, env);
		ctx.assert.eq(committed.committed_from, "stored_preview", "commit falls back to stored preview after cache reset");
		ctx.assert.eq(db.proposals.get(proposalId)?.status, "applied", "commit marks proposal applied");

		const persistedAfterCommit = db.readPlan(plan.id);
		ctx.assert.eq(
			persistedAfterCommit.prep_tasks.find(task => task.id === "task:slow_dough")?.scheduled_date,
			"2026-06-04",
			"commit persists updated prep task date",
		);
		ctx.assert.eq(
			persistedAfterCommit.component_batches.find(batch => batch.id === "batch:slow_dough")?.meta.desired_prep_date,
			"2026-06-04",
			"commit persists updated batch prep metadata",
		);

		const final = await callPlanWorldTool("plan_finalize", { plan_id: plan.id }, env);
		ctx.assert.eq(final.ok, true, "final persisted world is accepted");
		ctx.assert.eq(Number((final.summary as any)?.grievance_counts?.hard ?? -1), 0, "final hard grievances are zero");
		ctx.assert.eq(Number((final.summary as any)?.coherence_score ?? -1), 0, "final coherence score is zero");
	},
};

function makeTooEarlyDoughPlan(): MiseWeeklyPlanDraft {
	const meal: MisePlanMeal = {
		id: "meal:sat_pizza",
		date: "2026-06-06",
		slot: "dinner",
		title: "Cold Ferment Pizza",
		format: "pizza",
		component_ids: ["batch:slow_dough"],
		ingredient_names: [],
		source: "synthetic_test",
		notes: [],
		people: 2,
		cuisine: ["italian"],
		locked: false,
	};
	const batch: MisePlanComponentBatch = {
		id: "batch:slow_dough",
		state_id: null,
		label: "48h Cold Ferment Dough",
		quantity: 600,
		unit: "g",
		storage: "refrigerator",
		container: null,
		quality_window_hours: 120,
		planned_uses: [{ date: "2026-06-06", slot: "dinner", meal_id: meal.id, title: meal.title }],
		station_tags: [],
		equipment: [],
		active_time_min: 20,
		idle_time_min: 2880,
		input_names: [],
		meta: { desired_prep_date: "2026-06-06" },
	};
	const task: MisePlanTask = {
		id: "task:slow_dough",
		scheduled_date: "2026-06-06",
		session_order: 0,
		task_type: "component_prep",
		title: "Prep 48h dough",
		station_tags: [],
		equipment: [],
		depends_on: [],
		state_inputs: [],
		state_outputs: [batch.id],
		active_time_min: 20,
		idle_time_min: 2880,
		instructions: [],
		status: "planned",
		meta: {},
	};
	return {
		id: "mise_plan:t17",
		household_id: "test",
		title: "T17 Persistence Fixture",
		start_date: "2026-06-01",
		end_date: "2026-06-07",
		timezone: "UTC",
		people: 2,
		status: "draft",
		constraints: {},
		selected_ingredients: [],
		source_recipe_ids: [],
		meals_by_day: [{ date: "2026-06-06", day_index: 5, meals: [meal] }],
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

class FakeD1 {
	plans = new Map<string, string>();
	proposals = new Map<string, { plan_id: string; status: string; meta_json: string }>();

	prepare(sql: string): FakeStatement {
		return new FakeStatement(this, sql);
	}

	readPlan(id: string): MiseWeeklyPlanDraft {
		const raw = this.plans.get(id);
		if (!raw) throw new Error(`missing plan ${id}`);
		return JSON.parse(raw) as MiseWeeklyPlanDraft;
	}
}

class FakeStatement {
	private bindings: unknown[] = [];

	constructor(private readonly db: FakeD1, private readonly sql: string) {}

	bind(...values: unknown[]): this {
		this.bindings = values;
		return this;
	}

	async first<T = unknown>(): Promise<T | null> {
		if (/FROM\s+mise_week_plans/i.test(this.sql)) {
			const plan_json = this.db.plans.get(String(this.bindings[0]));
			return (plan_json ? { plan_json } : null) as T | null;
		}
		if (/FROM\s+mise_plan_proposals/i.test(this.sql)) {
			const row = this.db.proposals.get(String(this.bindings[0]));
			if (!row || row.plan_id !== String(this.bindings[1])) return null;
			return { meta_json: row.meta_json } as T;
		}
		return null;
	}

	async run(): Promise<unknown> {
		if (/INSERT\s+OR\s+REPLACE\s+INTO\s+mise_week_plans/i.test(this.sql)) {
			this.db.plans.set(String(this.bindings[0]), String(this.bindings[11]));
		} else if (/INSERT\s+OR\s+REPLACE\s+INTO\s+mise_plan_proposals/i.test(this.sql)) {
			this.db.proposals.set(String(this.bindings[0]), {
				plan_id: String(this.bindings[1]),
				status: String(this.bindings[5]),
				meta_json: String(this.bindings[10]),
			});
		} else if (/UPDATE\s+mise_plan_proposals/i.test(this.sql)) {
			const row = this.db.proposals.get(String(this.bindings[0]));
			if (row && row.plan_id === String(this.bindings[1])) row.status = "applied";
		}
		return { success: true };
	}

	async all(): Promise<{ results: unknown[] }> {
		return { results: [] };
	}
}

export default t17;
