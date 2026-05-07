// U57 — Brigade scheduler skeleton contract test.
//
// `tickScheduler` is a pure function that the CookingLeadAgent calls every
// 10s to decide which task gets assigned to which member. Wave 8 ships a
// stub that always returns zero new assignments. The stub's job is to lock
// the I/O contract so Wave 8B can fill in the heuristic without touching
// callers.
//
// This scenario asserts:
//   1. Empty graph → empty output, no throw, notes record the tick state.
//   2. Graph with no members → empty output, no throw.
//   3. Graph with idle member but no DAG-ready task (all completed) → empty
//      output, ready_for_completion_check empty.
//   4. In-flight assignment older than 30 minutes is reported in
//      ready_for_completion_check.
//   5. Recent in-flight assignment (under 30 minutes) is NOT reported.
//   6. `readyTasks` helper correctly filters by deps + completion + in-flight.

import type { Scenario } from "../lib/types";
import {
	readyTasks,
	tickScheduler,
} from "../../src/mise-graph/agents/cooking-lead-scheduler";
import type {
	BrigadeMember,
	BrigadeSchedulerInput,
	InFlightAssignment,
} from "../../src/mise-graph/agents/cooking-lead-types";
import type { TaskGraph, TaskNode } from "../../src/mise-graph/task-graph-types";

function makeTask(id: string, depends_on: string[] = []): TaskNode {
	return {
		id,
		recipe_id: "r1",
		step_idx: 0,
		kind: "prep",
		label: id,
		skill: "knife_basic",
		skill_floor: 0.5,
		equipment: [],
		ingredients_in: [],
		produces: id,
		active_min: 5,
		passive_min: 0,
		parallelizable: true,
		depends_on,
	};
}

function makeGraph(tasks: TaskNode[] = []): TaskGraph {
	return {
		recipe_id: "r1",
		meal_id: "meal_u57",
		tasks,
		critical_path_min: tasks.reduce((s, t) => s + t.active_min, 0),
		total_active_min: tasks.reduce((s, t) => s + t.active_min, 0),
		total_passive_min: 0,
		parallelism_max: 1,
	};
}

const NOW = 1_750_000_000_000;

const u57: Scenario = {
	id: "u57",
	name: "Brigade scheduler skeleton: empty input + in-flight stale detection",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// 1. Empty graph.
		const empty: BrigadeSchedulerInput = {
			graph: makeGraph(),
			members: [],
			completed_task_ids: new Set(),
			in_flight_assignments: [],
			now_ms: NOW,
		};
		const r1 = tickScheduler(empty);
		ctx.assert.eq(r1.new_assignments.length, 0, "empty graph: zero assignments");
		ctx.assert.eq(r1.unassignable_tasks.length, 0, "empty graph: zero unassignable");
		ctx.assert.eq(r1.ready_for_completion_check.length, 0, "empty graph: zero ready-for-completion");
		ctx.assert.ok(Array.isArray(r1.notes), "notes is an array");
		ctx.assert.gte(r1.notes.length, 1, "notes records the tick state");

		// 2. Graph but no members.
		const gNoMembers: BrigadeSchedulerInput = {
			graph: makeGraph([makeTask("t1"), makeTask("t2", ["t1"])]),
			members: [],
			completed_task_ids: new Set(),
			in_flight_assignments: [],
			now_ms: NOW,
		};
		const r2 = tickScheduler(gNoMembers);
		ctx.assert.eq(r2.new_assignments.length, 0, "no members: zero assignments");

		// 3. Member idle but everything completed.
		const member: BrigadeMember = {
			member_id: "alice",
			skills: { knife_basic: 0.9 },
			presence: "in_kitchen_idle",
		};
		const allDone: BrigadeSchedulerInput = {
			graph: makeGraph([makeTask("t1"), makeTask("t2")]),
			members: [member],
			completed_task_ids: new Set(["t1", "t2"]),
			in_flight_assignments: [],
			now_ms: NOW,
		};
		const r3 = tickScheduler(allDone);
		ctx.assert.eq(r3.new_assignments.length, 0, "all completed: zero new assignments");
		ctx.assert.eq(r3.ready_for_completion_check.length, 0, "no in-flight, no completion checks");

		// 4. Stale in-flight (started > 30 min ago).
		const stale: InFlightAssignment[] = [{
			task_id: "t_stale",
			member_id: "alice",
			started_at_ms: NOW - 31 * 60 * 1000,
			assigned_at_ms: NOW - 31 * 60 * 1000,
		}];
		const staleInput: BrigadeSchedulerInput = {
			graph: makeGraph([makeTask("t_stale")]),
			members: [member],
			completed_task_ids: new Set(),
			in_flight_assignments: stale,
			now_ms: NOW,
		};
		const r4 = tickScheduler(staleInput);
		ctx.assert.eq(r4.ready_for_completion_check.length, 1, "stale assignment is flagged");
		ctx.assert.eq(r4.ready_for_completion_check[0], "t_stale", "stale task id reported");

		// 5. Recent in-flight (started 10 min ago) — NOT flagged.
		const recent: InFlightAssignment[] = [{
			task_id: "t_recent",
			member_id: "alice",
			started_at_ms: NOW - 10 * 60 * 1000,
			assigned_at_ms: NOW - 10 * 60 * 1000,
		}];
		const r5 = tickScheduler({ ...staleInput, in_flight_assignments: recent });
		ctx.assert.eq(r5.ready_for_completion_check.length, 0, "recent assignment is NOT flagged");

		// 6. readyTasks helper.
		const readyInput: BrigadeSchedulerInput = {
			graph: makeGraph([
				makeTask("t1"),
				makeTask("t2", ["t1"]),
				makeTask("t3", ["t2"]),
			]),
			members: [],
			completed_task_ids: new Set(["t1"]),
			in_flight_assignments: [{
				task_id: "t2",
				member_id: "alice",
				assigned_at_ms: NOW,
				started_at_ms: NOW,
			}],
			now_ms: NOW,
		};
		const ready = readyTasks(readyInput);
		ctx.assert.eq(ready.length, 0, "no DAG-ready tasks: t1 done, t2 in-flight, t3 deps not met");

		const readyAfterT2: BrigadeSchedulerInput = {
			...readyInput,
			completed_task_ids: new Set(["t1", "t2"]),
			in_flight_assignments: [],
		};
		const ready2 = readyTasks(readyAfterT2);
		ctx.assert.eq(ready2.length, 1, "t3 becomes ready after t2 completes");
		ctx.assert.eq(ready2[0].id, "t3", "the ready task is t3");
	},
};

export default u57;
