// U47 — PlanAgent finalize: plan-cycles helpers + persistence.
//
// The Agents SDK can't boot in node, so we exercise the extracted plan-cycles
// helpers (buildPlanHealthRow, recomputePlanHealth, persistPlanHealthRow,
// nextRecomputeAt) plus the spawn flow contract (mealAgentName, shopAgentName).

import type { Scenario } from "../lib/types";
import { createMockD1 } from "../lib/mock-d1";
import { migratePlanHealthSchema } from "../../src/mise-graph/schemas/migrations";
import {
	buildPlanHealthRow,
	nextRecomputeAt,
	persistPlanHealthRow,
} from "../../src/mise-graph/agents/plan-cycles";
import { mealAgentName, shopAgentName } from "../../src/mise-graph/agents/base";
import type { MiseGraphEnv } from "../../src/mise-graph/types";
import type { MiseWeeklyPlanDraft } from "../../src/mise-graph/planner";

const u47: Scenario = {
	id: "u47",
	name: "PlanAgent: nightly recompute helpers, schedule names, persistence",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// ── 1. nextRecomputeAt is +24h ─────────────────────────────────────
		const t0 = new Date("2026-05-13T12:00:00Z");
		const t1 = nextRecomputeAt(t0);
		ctx.assert.eq(
			t1.toISOString(),
			"2026-05-14T12:00:00.000Z",
			"nextRecomputeAt is +24h from input",
		);

		// ── 2. Child agent name format matches base ────────────────────────
		ctx.assert.eq(
			mealAgentName("p1", "2026-05-13", "dinner"),
			"meal:p1:2026-05-13:dinner",
			"mealAgentName: documented format",
		);
		ctx.assert.eq(
			shopAgentName("p1", "shop_run_42"),
			"shop:p1:shop_run_42",
			"shopAgentName: documented format",
		);

		// ── 3. buildPlanHealthRow folds critics into a row ─────────────────
		const plan = makeMinimalPlan("p1", "hh_a", "2026-05-13");
		const row = buildPlanHealthRow("p1", "hh_a", plan, new Date("2026-05-13T12:00:00Z"));
		ctx.assert.eq(row.plan_id, "p1", "row carries plan_id");
		ctx.assert.eq(row.household_id, "hh_a", "row carries household_id");
		ctx.assert.eq(row.recorded_on, "2026-05-13", "recorded_on is YYYY-MM-DD slice of now");
		ctx.assert.gte(row.hard_grievance_count, 0, "hard count is non-negative");
		ctx.assert.gte(row.warning_grievance_count, 0, "warning count is non-negative");
		ctx.assert.eq(typeof row.coherence_score, "number", "coherence_score is a number");
		ctx.assert.eq(Array.isArray(row.issue_summary), true, "issue_summary is an array");
		ctx.assert.matches(row.id, /^ph_/, "row id is prefixed");
		ctx.assert.eq(row.created_at_ms, row.updated_at_ms, "created_at_ms = updated_at_ms on first build");

		// ── 4. persistPlanHealthRow into mock D1 + verify load by select ───
		const db = createMockD1();
		const env = { DB: db as unknown as D1Database } as MiseGraphEnv;
		await migratePlanHealthSchema(env);

		await persistPlanHealthRow(env, row);
		const loadResult = await env.DB.prepare(
			`SELECT id, plan_id, household_id, recorded_on, coherence_score,
			        hard_grievance_count, warning_grievance_count
			 FROM mise_plan_health WHERE plan_id = ? ORDER BY created_at_ms DESC LIMIT 1`,
		).bind("p1").first<{
			id: string;
			plan_id: string;
			household_id: string;
			recorded_on: string;
			coherence_score: number;
			hard_grievance_count: number;
			warning_grievance_count: number;
		}>();
		ctx.assert.ok(!!loadResult, "persisted row loadable");
		ctx.assert.eq(loadResult!.plan_id, "p1", "round-trip plan_id");
		ctx.assert.eq(loadResult!.household_id, "hh_a", "round-trip household_id");
		ctx.assert.eq(loadResult!.recorded_on, "2026-05-13", "round-trip recorded_on");
		ctx.assert.eq(loadResult!.hard_grievance_count, row.hard_grievance_count, "round-trip hard count");

		// ── 5. Same-day re-persist: with conflict the second row's data wins
		// (mock-d1 doesn't enforce UNIQUE so this just checks both writes
		// succeed without error and the latest is reachable). ───────────────
		const row2 = buildPlanHealthRow("p1", "hh_a", plan, new Date("2026-05-13T13:00:00Z"));
		await persistPlanHealthRow(env, row2);
		const after = await env.DB.prepare(
			`SELECT id FROM mise_plan_health WHERE plan_id = ? ORDER BY created_at_ms DESC LIMIT 1`,
		).bind("p1").first<{ id: string }>();
		ctx.assert.eq(after!.id, row2.id, "latest row wins by created_at_ms");

		ctx.notes.push(`row id sample: ${row.id}`);
		ctx.notes.push(`hard=${row.hard_grievance_count} warning=${row.warning_grievance_count}`);
	},
};

function makeMinimalPlan(plan_id: string, household_id: string, date: string): MiseWeeklyPlanDraft {
	return {
		id: plan_id,
		household_id,
		title: `plan ${plan_id}`,
		start_date: date,
		end_date: date,
		timezone: null,
		people: 2,
		status: "draft",
		constraints: {},
		selected_ingredients: [],
		source_recipe_ids: [],
		meals_by_day: [{ date, day_index: 0, meals: [] }],
		component_batches: [],
		prep_tasks: [],
		breakfasts: [],
		snack_boxes: [],
		shopping_list: [],
		shop_runs: [],
		storage_labels: [],
		meta: { generated_by: "mise_graph_planner", deterministic: true },
	} as MiseWeeklyPlanDraft;
}

export default u47;
