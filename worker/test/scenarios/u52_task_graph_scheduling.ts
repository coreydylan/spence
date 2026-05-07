// U52 — Task graph scheduling against a crew.
//
// Build a tagine task graph, then schedule it against three different crews:
//   1. A solo skilled adult — every task assigns to them, total ≈ critical path.
//   2. A two-cook crew (skilled adult + intermediate teen) — work parallelizes.
//   3. A toddler-only crew — all real cook tasks unassignable.

import type { Scenario } from "../lib/types";
import { buildTaskGraph, scheduleTaskGraph } from "../../src/mise-graph/task-graph";
import type { CrewMember, RecipeForDecomposition } from "../../src/mise-graph/task-graph-types";
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

const u52: Scenario = {
	id: "u52",
	name: "Task graph: schedule against a crew with skill confidence floors",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const fixture = ctx.loadFixture<TagineFixture>("recipe-tagine.json");
		const recipe: RecipeForDecomposition = {
			id: fixture.id,
			steps: fixture.steps,
			ingredients: fixture.ingredients,
			servings: fixture.servings,
			active_time_min: fixture.active_time_min,
			total_time_min: fixture.total_time_min,
		};

		const db = new TaskGraphFakeD1();
		const env = { DB: db as unknown as D1Database };

		const graph = await buildTaskGraph(env, {
			recipe_id: recipe.id,
			meal_id: "meal:sched:tagine",
			people: 4,
			recipe,
		});

		// ── 1. Solo skilled adult ──────────────────────────────────────────
		const adult: CrewMember = {
			member_id: "alice",
			skills: {
				knife_basic: 0.9,
				knife_advanced: 0.7,
				stove_basic: 0.9,
				stove_searing: 0.85,
				stove_emulsion: 0.7,
				oven_basic: 0.9,
				oven_temp_control: 0.7,
				baking: 0.6,
				dough_handling: 0.5,
				fermentation: 0.4,
				fryer: 0.7,
			},
			available_from_offset_min: 0,
		};
		const solo = scheduleTaskGraph(graph, [adult]);
		ctx.assert.ok(solo.ok, "solo skilled adult schedules every task");
		ctx.assert.eq(
			solo.assignments.length,
			graph.tasks.length,
			"every task gets an assignment",
		);
		ctx.assert.eq(solo.unassignable.length, 0, "no unassignable tasks for skilled adult");
		ctx.assert.gte(
			solo.total_duration_min,
			graph.critical_path_min,
			"solo total >= critical path (no parallelism gain)",
		);
		const everyToAlice = solo.assignments.every(a => a.member_id === "alice");
		ctx.assert.ok(everyToAlice, "all assignments routed to alice");

		// ── 2. Two-cook crew — work parallelizes ───────────────────────────
		const teen: CrewMember = {
			member_id: "bobby",
			skills: {
				knife_basic: 0.6,
				stove_basic: 0.4,
				oven_basic: 0.5,
				supervision_only: 1,
			},
			available_from_offset_min: 0,
		};
		const duo = scheduleTaskGraph(graph, [adult, teen]);
		ctx.assert.ok(duo.ok, "two-cook crew also fully schedules");
		ctx.assert.eq(duo.assignments.length, graph.tasks.length, "duo assigns every task");
		const bobbyTasks = duo.assignments.filter(a => a.member_id === "bobby").length;
		ctx.assert.gte(bobbyTasks, 1, "bobby picks up at least one task");
		ctx.assert.lte(
			duo.total_duration_min,
			solo.total_duration_min,
			"two-cook total <= solo total (parallelism win)",
		);

		// ── 3. Skill floor enforcement — toddler crew can't sear ───────────
		const toddler: CrewMember = {
			member_id: "tinker",
			skills: { knife_basic: 0.05, supervision_only: 1 },
			available_from_offset_min: 0,
		};
		const kidsOnly = scheduleTaskGraph(graph, [toddler]);
		ctx.assert.ok(!kidsOnly.ok, "toddler-only schedule fails");
		ctx.assert.gte(kidsOnly.unassignable.length, 1, "at least one task unassignable");
		const unassignKinds = new Set(kidsOnly.unassignable.map(t => t.skill));
		ctx.assert.ok(
			unassignKinds.has("stove_searing") || unassignKinds.has("oven_basic") || unassignKinds.has("stove_basic"),
			"unassignable tasks include the skilled cook steps",
		);

		// ── 4. Critical path lower-bounds the duo total ────────────────────
		ctx.assert.gte(
			duo.total_duration_min,
			graph.critical_path_min,
			"duo total still >= critical path",
		);

		// ── 5. Empty crew ──────────────────────────────────────────────────
		const empty = scheduleTaskGraph(graph, []);
		ctx.assert.ok(!empty.ok, "empty crew can't schedule");
		ctx.assert.eq(empty.unassignable.length, graph.tasks.length, "every task unassignable");

		ctx.notes.push(`solo total: ${solo.total_duration_min}min`);
		ctx.notes.push(`duo total: ${duo.total_duration_min}min`);
		ctx.notes.push(`bobby's tasks: ${bobbyTasks}`);
		ctx.notes.push(`unassignable for toddler: ${kidsOnly.unassignable.length}`);
	},
};

export default u52;
