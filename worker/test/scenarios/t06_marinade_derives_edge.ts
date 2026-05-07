// T6 — 24-hour marinade auto-derives a min_lead_time edge.
//
// Builds a synthetic plan with:
//   - A prep task on Tue 2026-05-12 that produces batch "marinated_tofu" with
//     idle_time_min = 1440 (24h marinade).
//   - A meal on Wed 2026-05-13 dinner that consumes that batch.
// Asserts that deriveDependencyEdges() produces a Cook→Meal min_lead_time edge
// with rule.value === 24 (hours), and that with exactly 24h between cook and
// meal the edge.status is 'ok' (and 'critical' since slack === 0).

import type { Scenario } from "../lib/types";
import { deriveDependencyEdges } from "../../src/mise-graph/dependency-edges";
import type {
	MiseWeeklyPlanDraft,
	MisePlanComponentBatch,
	MisePlanTask,
	MisePlanMeal,
} from "../../src/mise-graph/planner";

const t06: Scenario = {
	id: "t06",
	name: "Imported recipe with 24h marinade auto-derives Cook→Meal edge with min_lead_time(24h)",
	group: "ripple",
	tier: "fast",
	async run(ctx) {
		const meal: MisePlanMeal = {
			id: "meal:wed_dinner",
			date: "2026-05-13",
			slot: "dinner",
			title: "Marinated Tofu Bowl",
			format: "bowl",
			component_ids: ["mise_component:marinated_tofu"],
			ingredient_names: ["marinated tofu", "rice", "scallion"],
			source: "synthetic_test",
			notes: [],
			people: 2,
			cuisine: ["japanese"],
			locked: false,
		};

		const batch: MisePlanComponentBatch = {
			id: "mise_component:marinated_tofu",
			state_id: null,
			label: "Marinated Tofu",
			quantity: 400,
			unit: "g",
			storage: "refrigerator",
			container: null,
			quality_window_hours: 96,
			planned_uses: [{
				date: "2026-05-13",
				slot: "dinner",
				meal_id: "meal:wed_dinner",
				title: "Marinated Tofu Bowl",
			}],
			station_tags: ["protein_active"],
			equipment: ["bowl"],
			active_time_min: 10,
			idle_time_min: 1440, // 24h marinade
			input_names: ["tofu", "soy sauce", "ginger", "garlic"],
			meta: { source: "synthetic_test" },
		};

		const task: MisePlanTask = {
			id: "task:marinate_tofu",
			scheduled_date: "2026-05-12",
			session_order: 1,
			task_type: "marinate",
			title: "Marinate tofu (24h)",
			station_tags: ["protein_active"],
			equipment: ["bowl"],
			depends_on: [],
			state_inputs: ["tofu", "soy sauce", "ginger", "garlic"],
			state_outputs: ["mise_component:marinated_tofu"],
			active_time_min: 10,
			idle_time_min: 1440,
			instructions: ["Combine marinade", "Submerge tofu", "Refrigerate 24h"],
			status: "planned",
			meta: {},
		};

		const plan: MiseWeeklyPlanDraft = {
			id: "mise_plan:test_t06",
			household_id: null,
			title: "T06 marinade fixture",
			start_date: "2026-05-11",
			end_date: "2026-05-17",
			timezone: null,
			people: 2,
			status: "draft",
			constraints: {},
			selected_ingredients: [],
			source_recipe_ids: [],
			meals_by_day: [
				{ date: "2026-05-13", day_index: 2, meals: [meal] },
			],
			component_batches: [batch],
			prep_tasks: [task],
			breakfasts: [],
			snack_boxes: [],
			shopping_list: [],
			storage_labels: [],
			meta: { generated_by: "mise_graph_planner", deterministic: true },
		};

		const edges = deriveDependencyEdges(plan);
		ctx.notes.push(`derived edges: ${edges.length}`);
		for (const e of edges) ctx.notes.push(`  ${e.from.entity_type}→${e.to.entity_type} ${e.rule.kind}=${e.rule.value}h slack=${e.slack_hours}h status=${e.status}`);

		// Find the marinade-driven Cook→Meal min_lead_time edge.
		const marinadeEdge = edges.find(e =>
			e.from.entity_type === "Cook"
			&& e.to.entity_type === "Meal"
			&& e.rule.kind === "min_lead_time"
			&& e.derived_from.child_property === "idle_time_min",
		);
		ctx.assert.ok(!!marinadeEdge, "edges contain a Cook→Meal min_lead_time edge derived from idle_time_min");

		if (marinadeEdge) {
			ctx.assert.eq(marinadeEdge.from.entity_type, "Cook", "edge.from is a Cook entity");
			ctx.assert.eq(marinadeEdge.to.entity_type, "Meal", "edge.to is a Meal entity");
			ctx.assert.eq(marinadeEdge.rule.kind, "min_lead_time", "edge.rule.kind is min_lead_time");
			ctx.assert.eq(marinadeEdge.rule.value, 1440 / 60, "edge.rule.value is 24h (1440 min / 60)");
			ctx.assert.eq(marinadeEdge.from.date, "2026-05-12", "cook scheduled Tue");
			ctx.assert.eq(marinadeEdge.to.date, "2026-05-13", "meal on Wed");
			ctx.assert.eq(marinadeEdge.current_lead_time_hours, 24, "current lead is exactly 24h");
			ctx.assert.eq(marinadeEdge.status, "ok", "Tue cook + 24h = Wed start, exactly viable (status ok)");
			ctx.assert.ok(marinadeEdge.critical, "edge is on the critical path (slack < 25% of 24h)");
		}
	},
};

export default t06;
