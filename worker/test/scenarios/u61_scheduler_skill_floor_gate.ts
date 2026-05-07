// U61 — Brigade scheduler: skill floor gate.
//
// Task requires skill_floor=0.7 in stove_searing. Only member has 0.5.
// Expect zero candidates → task lands in unassignable_tasks.

import type { Scenario } from "../lib/types";
import { tickScheduler } from "../../src/mise-graph/agents/cooking-lead-scheduler";
import type {
	BrigadeMember,
	BrigadeSchedulerInput,
} from "../../src/mise-graph/agents/cooking-lead-types";
import type { TaskGraph, TaskNode } from "../../src/mise-graph/task-graph-types";

const NOW = 1_750_000_000_000;

const u61: Scenario = {
	id: "u61",
	name: "Brigade scheduler: skill floor gate routes ready task to unassignable",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const sear: TaskNode = {
			id: "task_sear_steak",
			recipe_id: "r1",
			step_idx: 0,
			kind: "cook",
			label: "sear the steak",
			skill: "stove_searing",
			skill_floor: 0.7,
			equipment: [],
			ingredients_in: [],
			produces: "seared_steak",
			active_min: 8,
			passive_min: 0,
			parallelizable: false,
			depends_on: [],
		};
		const graph: TaskGraph = {
			recipe_id: "r1",
			meal_id: "m1",
			tasks: [sear],
			critical_path_min: 8,
			total_active_min: 8,
			total_passive_min: 0,
			parallelism_max: 1,
		};
		const teen: BrigadeMember = {
			member_id: "teen",
			skills: { stove_searing: 0.5 },
			presence: "in_kitchen_idle",
		};

		const input: BrigadeSchedulerInput = {
			graph,
			members: [teen],
			completed_task_ids: new Set(),
			in_flight_assignments: [],
			now_ms: NOW,
		};

		const out = tickScheduler(input);
		ctx.assert.eq(out.new_assignments.length, 0, "no qualified member → no assignment");
		ctx.assert.eq(out.unassignable_tasks.length, 1, "ready but unassignable task is reported");
		ctx.assert.eq(out.unassignable_tasks[0].id, "task_sear_steak", "exact task id");

		// Member at exactly the floor IS allowed.
		const teen2: BrigadeMember = {
			...teen,
			skills: { stove_searing: 0.7 },
		};
		const out2 = tickScheduler({ ...input, members: [teen2] });
		ctx.assert.eq(out2.new_assignments.length, 1, "skill at floor → assignable");
		ctx.assert.eq(out2.unassignable_tasks.length, 0, "no longer unassignable");
	},
};

export default u61;
