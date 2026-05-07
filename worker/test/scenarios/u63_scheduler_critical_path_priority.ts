// U63 — Brigade scheduler: critical-path priority.
//
// Two ready tasks; one is on the critical path, the other is short. With
// only one idle member and capacity > 1, the critical-path task should
// win. Confirms the +0.5 critical-path bonus dominates skill-fit ties.

import type { Scenario } from "../lib/types";
import { tickScheduler } from "../../src/mise-graph/agents/cooking-lead-scheduler";
import type {
	BrigadeMember,
	BrigadeSchedulerInput,
} from "../../src/mise-graph/agents/cooking-lead-types";
import type { TaskGraph, TaskNode } from "../../src/mise-graph/task-graph-types";

const NOW = 1_750_000_000_000;

const u63: Scenario = {
	id: "u63",
	name: "Brigade scheduler: critical-path task wins under tight capacity",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// Long path: cp1 (60min) → cp2 (60min). Side branch: side1 (5min).
		// Critical path id set should include cp1 + cp2.
		const cp1: TaskNode = {
			id: "cp1",
			recipe_id: "r1",
			step_idx: 0,
			kind: "prep",
			label: "cp1",
			skill: "knife_basic",
			skill_floor: 0.3,
			equipment: [],
			ingredients_in: [],
			produces: "cp1",
			active_min: 60,
			passive_min: 0,
			parallelizable: true,
			depends_on: [],
		};
		const cp2: TaskNode = {
			...cp1,
			id: "cp2",
			step_idx: 1,
			label: "cp2",
			depends_on: ["cp1"],
			produces: "cp2",
		};
		const side1: TaskNode = {
			...cp1,
			id: "side1",
			step_idx: 2,
			label: "side1",
			active_min: 5,
			depends_on: [],
			produces: "side1",
		};

		const graph: TaskGraph = {
			recipe_id: "r1",
			meal_id: "m1",
			tasks: [cp1, cp2, side1],
			critical_path_min: 120,
			total_active_min: 125,
			total_passive_min: 0,
			parallelism_max: 2,
		};

		const alice: BrigadeMember = {
			member_id: "alice",
			skills: { knife_basic: 0.9 },
			presence: "in_kitchen_idle",
		};

		const input: BrigadeSchedulerInput = {
			graph,
			members: [alice],
			completed_task_ids: new Set(),
			in_flight_assignments: [],
			now_ms: NOW,
			max_concurrent_assignments: 1,
		};

		const out = tickScheduler(input);
		ctx.assert.eq(out.new_assignments.length, 1, "one member → one assignment");
		ctx.assert.eq(out.new_assignments[0].task_id, "cp1", "critical-path task wins");
		// The reason string should mention critical_path bonus.
		ctx.assert.contains(out.new_assignments[0].reason, "critical_path", "reason cites critical_path bonus");
	},
};

export default u63;
