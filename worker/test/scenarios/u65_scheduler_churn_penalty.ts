// U65 — Brigade scheduler: churn penalty.
//
// Two members both qualified for a single ready task. One of them just
// completed a different task ~10s ago (within the 30s churn window). The
// other has been idle. The churn penalty should push the assignment to
// the rested member.

import type { Scenario } from "../lib/types";
import { tickScheduler } from "../../src/mise-graph/agents/cooking-lead-scheduler";
import type {
	BrigadeMember,
	BrigadeSchedulerInput,
} from "../../src/mise-graph/agents/cooking-lead-types";
import type { TaskGraph, TaskNode } from "../../src/mise-graph/task-graph-types";

const NOW = 1_750_000_000_000;

const u65: Scenario = {
	id: "u65",
	name: "Brigade scheduler: churn penalty steers assignment to rested member",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const task: TaskNode = {
			id: "t_chop",
			recipe_id: "r1",
			step_idx: 0,
			kind: "prep",
			label: "chop onion",
			skill: "knife_basic",
			skill_floor: 0.5,
			equipment: [],
			ingredients_in: [],
			produces: "diced_onion",
			active_min: 5,
			passive_min: 0,
			parallelizable: true,
			depends_on: [],
		};
		const graph: TaskGraph = {
			recipe_id: "r1",
			meal_id: "m1",
			tasks: [task],
			critical_path_min: 5,
			total_active_min: 5,
			total_passive_min: 0,
			parallelism_max: 1,
		};

		// Both at the SAME confidence so the only differentiator is churn.
		const alice: BrigadeMember = {
			member_id: "alice",
			skills: { knife_basic: 0.8 },
			presence: "in_kitchen_idle",
		};
		const bob: BrigadeMember = {
			member_id: "bob",
			skills: { knife_basic: 0.8 },
			presence: "in_kitchen_idle",
		};

		// alice just finished something 10s ago.
		const churn_input: BrigadeSchedulerInput = {
			graph,
			members: [alice, bob],
			completed_task_ids: new Set(["t_prev"]),
			in_flight_assignments: [],
			now_ms: NOW,
			recently_completed: [{
				task_id: "t_prev",
				member_id: "alice",
				completed_at_ms: NOW - 10_000,
			}],
		};
		const out = tickScheduler(churn_input);
		ctx.assert.eq(out.new_assignments.length, 1, "one task, one assignment");
		ctx.assert.eq(out.new_assignments[0].member_id, "bob", "rested bob wins; churned alice deferred");
		ctx.assert.contains(out.new_assignments[0].reason, "skill_fit", "reason cites skill_fit");

		// Verify alice IS the winner when she's NOT recently churned.
		const fresh_input: BrigadeSchedulerInput = {
			...churn_input,
			recently_completed: [],
		};
		const out2 = tickScheduler(fresh_input);
		ctx.assert.eq(out2.new_assignments.length, 1, "still one assignment");
		// Without churn, alice and bob are tied; greedy picks the first
		// candidate generated (alice in input order). We just assert ONE of
		// them got it — the determinism is in the input order.
		ctx.assert.contains(["alice", "bob"], out2.new_assignments[0].member_id, "either tied member wins");
	},
};

export default u65;
