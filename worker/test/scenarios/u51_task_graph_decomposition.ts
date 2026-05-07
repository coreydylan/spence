// U51 — Task graph decomposition.
//
// Given a fixture recipe (lamb tagine), call buildTaskGraph and assert:
//   * the right number of tasks come out (~6-10),
//   * each step's task has the expected kind/skill/equipment,
//   * preheat oven gates the bake/roast task,
//   * prep tasks gate the first cook task,
//   * critical_path_min is dominated by the long oven roast,
//   * parallelism_max >= 2 (preheat in parallel with prep),
//   * the graph round-trips through getTaskGraph after persistence.

import type { Scenario } from "../lib/types";
import {
	buildTaskGraph,
	getTaskGraph,
	criticalPath,
} from "../../src/mise-graph/task-graph";
import type { RecipeForDecomposition } from "../../src/mise-graph/task-graph-types";
import { TaskGraphFakeD1 } from "../lib/wave7c-fake-d1";

interface TagineFixture {
	id: string;
	title: string;
	servings: number;
	active_time_min: number;
	total_time_min: number;
	ingredients: string[];
	steps: string[];
}

const u51: Scenario = {
	id: "u51",
	name: "Task graph: decompose a tagine recipe into a DAG of skill+equipment tasks",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const fixture = ctx.loadFixture<TagineFixture>("recipe-tagine.json");
		const recipe: RecipeForDecomposition = {
			id: fixture.id,
			title: fixture.title,
			servings: fixture.servings,
			active_time_min: fixture.active_time_min,
			total_time_min: fixture.total_time_min,
			ingredients: fixture.ingredients,
			steps: fixture.steps,
		};

		const db = new TaskGraphFakeD1();
		const env = { DB: db as unknown as D1Database };
		const meal_id = "meal:test:tagine";

		const graph = await buildTaskGraph(env, {
			recipe_id: recipe.id,
			meal_id,
			people: 4,
			recipe,
		});

		// ── 1. Task count ──────────────────────────────────────────────────
		ctx.assert.gte(graph.tasks.length, 6, "tagine decomposes into at least 6 tasks");
		ctx.assert.lte(graph.tasks.length, 10, "tagine decomposes into at most 10 tasks");
		ctx.assert.eq(graph.recipe_id, recipe.id, "graph references recipe id");
		ctx.assert.eq(graph.meal_id, meal_id, "graph references meal id");

		// ── 2. Per-step classification ─────────────────────────────────────
		const tasksByStep = new Map<number, typeof graph.tasks[0]>();
		for (const t of graph.tasks) tasksByStep.set(t.step_idx, t);

		const preheat = tasksByStep.get(0);
		ctx.assert.ok(!!preheat, "step 0 (preheat) yields a task");
		ctx.assert.eq(preheat!.kind, "cook", "preheat task is kind=cook");
		ctx.assert.contains(preheat!.equipment, "oven", "preheat uses oven");
		ctx.assert.eq(preheat!.parallelizable, true, "preheat runs in parallel");
		ctx.assert.eq(preheat!.skill, "oven_basic", "preheat is oven_basic skill");

		const dice = tasksByStep.get(1);
		ctx.assert.ok(!!dice, "step 1 (dice) yields a task");
		ctx.assert.eq(dice!.kind, "prep", "dice task is kind=prep");
		ctx.assert.eq(dice!.skill, "knife_basic", "dice uses knife_basic");
		ctx.assert.contains(dice!.equipment, "chefs_knife", "dice equipment includes knife");
		ctx.assert.contains(dice!.equipment, "cutting_board", "dice equipment includes cutting board");
		ctx.assert.eq(dice!.parallelizable, true, "dice can run in parallel");

		const brown = tasksByStep.get(2);
		ctx.assert.ok(!!brown, "step 2 (brown) yields a task");
		ctx.assert.eq(brown!.kind, "cook", "brown task is kind=cook");
		ctx.assert.eq(brown!.skill, "stove_searing", "brown uses stove_searing");
		ctx.assert.eq(brown!.parallelizable, false, "brown does NOT run in parallel");
		ctx.assert.contains(brown!.equipment, "skillet", "brown equipment includes skillet");

		const saute = tasksByStep.get(3);
		ctx.assert.ok(!!saute, "step 3 (saute) yields a task");
		ctx.assert.eq(saute!.kind, "cook", "saute task is kind=cook");
		ctx.assert.eq(saute!.skill, "stove_basic", "saute uses stove_basic");

		const roast = tasksByStep.get(5);
		ctx.assert.ok(!!roast, "step 5 (roast) yields a task");
		ctx.assert.eq(roast!.kind, "passive", "roast task is kind=passive");
		ctx.assert.gte(roast!.passive_min, 60, "roast passive_min picks up the 90 minute hint");
		ctx.assert.contains(roast!.equipment, "oven", "roast uses oven");

		// ── 3. Dependency wiring ───────────────────────────────────────────
		ctx.assert.contains(roast!.depends_on, preheat!.id, "roast depends on preheat (oven gating)");
		ctx.assert.contains(brown!.depends_on, dice!.id, "first cook task depends on prior prep (soft gate)");

		// ── 4. Aggregate metrics ───────────────────────────────────────────
		ctx.assert.gte(graph.critical_path_min, 75, "critical path dominated by oven roast (>=75min)");
		ctx.assert.lte(graph.critical_path_min, 200, "critical path is bounded (<=200min for ~2hr recipe)");
		ctx.assert.gte(graph.parallelism_max, 2, "parallelism_max >= 2 (preheat || prep)");
		ctx.assert.gte(graph.total_active_min, 30, "total active time is meaningful");
		ctx.assert.gte(graph.total_passive_min, 60, "total passive time captured from oven roast");

		// ── 5. Critical path callout ───────────────────────────────────────
		const critical = criticalPath(graph);
		ctx.assert.gt(critical.tasks.length, 0, "critical path has at least one task");
		ctx.assert.eq(
			critical.total_min,
			graph.critical_path_min,
			"criticalPath() agrees with stored critical_path_min",
		);
		const onPath = new Set(critical.tasks.map(t => t.id));
		ctx.assert.ok(onPath.has(roast!.id), "roast task is on the critical path");

		// ── 6. Persistence round-trip ─────────────────────────────────────
		const reloaded = await getTaskGraph(env, meal_id);
		ctx.assert.ok(!!reloaded, "graph round-trips through D1");
		ctx.assert.eq(reloaded!.tasks.length, graph.tasks.length, "task count round-trips");
		ctx.assert.eq(reloaded!.critical_path_min, graph.critical_path_min, "critical_path_min round-trips");
		ctx.assert.eq(reloaded!.parallelism_max, graph.parallelism_max, "parallelism_max round-trips");

		// ── 7. People scaling — bigger crowd = longer prep ─────────────────
		const bigger = await buildTaskGraph(env, {
			recipe_id: recipe.id,
			meal_id: "meal:test:tagine_big",
			people: 12,
			recipe,
		});
		const dice4 = graph.tasks.find(t => t.step_idx === 1)!;
		const dice12 = bigger.tasks.find(t => t.step_idx === 1)!;
		ctx.assert.gte(
			dice12.active_min,
			dice4.active_min,
			"prep scales sub-linearly with people (12 takes >= 4)",
		);

		ctx.notes.push(`tasks: ${graph.tasks.length}`);
		ctx.notes.push(`critical_path: ${graph.critical_path_min}min`);
		ctx.notes.push(`parallelism_max: ${graph.parallelism_max}`);
		ctx.notes.push(`active=${graph.total_active_min}min passive=${graph.total_passive_min}min`);
	},
};

export default u51;
