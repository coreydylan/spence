// U66 — Brigade scheduler: passive-task batching bonus.
//
// Two ready tasks, one passive (proof dough), one active prep. Both
// equally skilled candidates. Capacity=1. The passive task should win
// because of the +0.3 passive bonus, freeing the active member for an
// upcoming busy stretch.
//
// Also covers: passive task on critical path stacks both bonuses.

import type { Scenario } from "../lib/types";
import { tickScheduler } from "../../src/mise-graph/agents/cooking-lead-scheduler";
import type {
	BrigadeMember,
	BrigadeSchedulerInput,
} from "../../src/mise-graph/agents/cooking-lead-types";
import type { TaskGraph, TaskNode } from "../../src/mise-graph/task-graph-types";

const NOW = 1_750_000_000_000;

const u66: Scenario = {
	id: "u66",
	name: "Brigade scheduler: passive bonus prefers passive task under tight capacity",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const passiveProof: TaskNode = {
			id: "proof_dough",
			recipe_id: "r1",
			step_idx: 0,
			kind: "passive",
			label: "proof the dough",
			skill: "supervision_only",
			skill_floor: 0,
			equipment: [],
			ingredients_in: [],
			produces: "rested_dough",
			active_min: 1,
			passive_min: 60,
			parallelizable: true,
			depends_on: [],
		};
		const activePrep: TaskNode = {
			id: "chop_onion",
			recipe_id: "r1",
			step_idx: 1,
			kind: "prep",
			label: "chop the onion",
			skill: "knife_basic",
			skill_floor: 0.3,
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
			tasks: [passiveProof, activePrep],
			critical_path_min: 61,
			total_active_min: 6,
			total_passive_min: 60,
			parallelism_max: 2,
		};

		const alice: BrigadeMember = {
			member_id: "alice",
			skills: { knife_basic: 0.8, supervision_only: 1.0 },
			presence: "in_kitchen_idle",
		};

		// Capacity 1 — passive should win the slot.
		const out = tickScheduler({
			graph,
			members: [alice],
			completed_task_ids: new Set(),
			in_flight_assignments: [],
			now_ms: NOW,
			max_concurrent_assignments: 1,
		});
		ctx.assert.eq(out.new_assignments.length, 1, "one slot, one assignment");
		ctx.assert.eq(out.new_assignments[0].task_id, "proof_dough", "passive task batched first");
		ctx.assert.contains(out.new_assignments[0].reason, "passive", "reason cites passive bonus");

		// With a non-passive critical-path task in play, the +0.5 CP bonus
		// stomps the +0.3 passive bonus.
		const cpActive: TaskNode = { ...activePrep, active_min: 90, id: "active_cp" };
		const cpGraph: TaskGraph = {
			...graph,
			tasks: [passiveProof, cpActive],
			critical_path_min: 90,
		};
		const out2 = tickScheduler({
			graph: cpGraph,
			members: [alice],
			completed_task_ids: new Set(),
			in_flight_assignments: [],
			now_ms: NOW,
			max_concurrent_assignments: 1,
		});
		ctx.assert.eq(out2.new_assignments.length, 1, "one slot");
		ctx.assert.eq(out2.new_assignments[0].task_id, "active_cp", "critical-path bonus beats passive bonus");
	},
};

export default u66;
