// U62 — Brigade scheduler: DAG dependency gating.
//
// Three tasks chained: t1 → t2 → t3. With nothing complete, only t1 is
// DAG-ready. After t1 completes, t2 becomes ready. After t2 completes,
// t3. Multiple idle members don't change this — the scheduler must
// respect dependencies.

import type { Scenario } from "../lib/types";
import { tickScheduler } from "../../src/mise-graph/agents/cooking-lead-scheduler";
import type {
	BrigadeMember,
	BrigadeSchedulerInput,
} from "../../src/mise-graph/agents/cooking-lead-types";
import type { TaskGraph, TaskNode } from "../../src/mise-graph/task-graph-types";

function makeTask(id: string, depends_on: string[] = []): TaskNode {
	return {
		id,
		recipe_id: "r1",
		step_idx: Number(id.replace(/[^0-9]/g, "")) || 0,
		kind: "prep",
		label: id,
		skill: "knife_basic",
		skill_floor: 0.3,
		equipment: [],
		ingredients_in: [],
		produces: id,
		active_min: 5,
		passive_min: 0,
		parallelizable: true,
		depends_on,
	};
}

const NOW = 1_750_000_000_000;

const u62: Scenario = {
	id: "u62",
	name: "Brigade scheduler: respects DAG dependencies across ticks",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const tasks: TaskNode[] = [
			makeTask("t1"),
			makeTask("t2", ["t1"]),
			makeTask("t3", ["t2"]),
		];
		const graph: TaskGraph = {
			recipe_id: "r1",
			meal_id: "m1",
			tasks,
			critical_path_min: 15,
			total_active_min: 15,
			total_passive_min: 0,
			parallelism_max: 1,
		};

		const members: BrigadeMember[] = [
			{ member_id: "alice", skills: { knife_basic: 0.9 }, presence: "in_kitchen_idle" },
			{ member_id: "bob",   skills: { knife_basic: 0.9 }, presence: "in_kitchen_idle" },
			{ member_id: "carol", skills: { knife_basic: 0.9 }, presence: "in_kitchen_idle" },
		];

		// Tick 1: nothing done, only t1 ready.
		const tick1 = tickScheduler({
			graph,
			members,
			completed_task_ids: new Set(),
			in_flight_assignments: [],
			now_ms: NOW,
		});
		ctx.assert.eq(tick1.new_assignments.length, 1, "only t1 assigned (others gated by deps)");
		ctx.assert.eq(tick1.new_assignments[0].task_id, "t1", "t1 assigned first");

		// Tick 2: t1 complete, only t2 ready.
		const tick2 = tickScheduler({
			graph,
			members,
			completed_task_ids: new Set(["t1"]),
			in_flight_assignments: [],
			now_ms: NOW,
		});
		ctx.assert.eq(tick2.new_assignments.length, 1, "only t2 assigned after t1 done");
		ctx.assert.eq(tick2.new_assignments[0].task_id, "t2", "t2 assigned next");

		// Tick 3: t1+t2 complete, only t3 ready.
		const tick3 = tickScheduler({
			graph,
			members,
			completed_task_ids: new Set(["t1", "t2"]),
			in_flight_assignments: [],
			now_ms: NOW,
		});
		ctx.assert.eq(tick3.new_assignments.length, 1, "only t3 assigned after t2 done");
		ctx.assert.eq(tick3.new_assignments[0].task_id, "t3", "t3 last");

		// Tick 4: t1 in-flight, t2/t3 still gated.
		const tick4 = tickScheduler({
			graph,
			members,
			completed_task_ids: new Set(),
			in_flight_assignments: [{
				task_id: "t1",
				member_id: "alice",
				assigned_at_ms: NOW,
				started_at_ms: NOW,
			}],
			now_ms: NOW,
		});
		ctx.assert.eq(tick4.new_assignments.length, 0, "t1 in-flight, t2/t3 still gated → zero new");
	},
};

export default u62;
