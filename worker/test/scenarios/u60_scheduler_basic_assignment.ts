// U60 — Brigade scheduler: basic assignment.
//
// Two idle members, four DAG-ready tasks (all independent). Expect both
// members to get one task each in this tick — capacity per-member is 1.
// The remaining ready tasks stay unassigned but are NOT unassignable
// (the scheduler is pacing itself, not refusing).

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

const u60: Scenario = {
	id: "u60",
	name: "Brigade scheduler: assigns top-K independent tasks to idle members",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const tasks: TaskNode[] = [
			makeTask("t1"),
			makeTask("t2"),
			makeTask("t3"),
			makeTask("t4"),
		];
		const graph: TaskGraph = {
			recipe_id: "r1",
			meal_id: "m1",
			tasks,
			critical_path_min: 5,
			total_active_min: 20,
			total_passive_min: 0,
			parallelism_max: 4,
		};

		const alice: BrigadeMember = {
			member_id: "alice",
			skills: { knife_basic: 0.9 },
			presence: "in_kitchen_idle",
		};
		const bob: BrigadeMember = {
			member_id: "bob",
			skills: { knife_basic: 0.7 },
			presence: "in_kitchen_idle",
		};

		const input: BrigadeSchedulerInput = {
			graph,
			members: [alice, bob],
			completed_task_ids: new Set(),
			in_flight_assignments: [],
			now_ms: NOW,
		};

		const out = tickScheduler(input);

		ctx.assert.eq(out.new_assignments.length, 2, "two members → two assignments");

		// Each member appears at most once.
		const memberIds = out.new_assignments.map(a => a.member_id);
		ctx.assert.eq(new Set(memberIds).size, 2, "no member double-assigned");

		// Each task assigned at most once.
		const taskIds = out.new_assignments.map(a => a.task_id);
		ctx.assert.eq(new Set(taskIds).size, 2, "no task double-assigned");

		// Higher-skill member (alice) wins their task — assignments should
		// reflect she got picked. Both candidates qualify so both assigned.
		ctx.assert.contains(memberIds, "alice", "alice assigned");
		ctx.assert.contains(memberIds, "bob", "bob assigned");

		ctx.assert.eq(out.unassignable_tasks.length, 0, "remaining tasks ARE candidates, just paced — not unassignable");
		ctx.assert.eq(out.ready_for_completion_check.length, 0, "no in-flight to check");
	},
};

export default u60;
