// U64 — Brigade scheduler: equipment exclusivity.
//
// Two ready tasks both need the oven (capacity 1, exclusive). Two idle
// members. Only one of the two tasks gets assigned this tick — the other
// waits because the oven would conflict.
//
// Also covers the "claim already held by an outside session" path: when
// `current_equipment_claims` shows an active claim on the oven, NO oven
// task can be assigned even if no one else in this batch has it yet.

import type { Scenario } from "../lib/types";
import { tickScheduler } from "../../src/mise-graph/agents/cooking-lead-scheduler";
import type {
	BrigadeMember,
	BrigadeSchedulerInput,
} from "../../src/mise-graph/agents/cooking-lead-types";
import type { TaskGraph, TaskNode } from "../../src/mise-graph/task-graph-types";

const NOW = 1_750_000_000_000;

function makeOvenTask(id: string): TaskNode {
	return {
		id,
		recipe_id: "r1",
		step_idx: Number(id.replace(/[^0-9]/g, "")) || 0,
		kind: "passive",
		label: id,
		skill: "oven_basic",
		skill_floor: 0.3,
		equipment: ["oven"],
		ingredients_in: [],
		produces: id,
		active_min: 2,
		passive_min: 30,
		parallelizable: true,
		depends_on: [],
	};
}

const u64: Scenario = {
	id: "u64",
	name: "Brigade scheduler: exclusive equipment limits one assignment per tick",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const tasks = [makeOvenTask("bake_a"), makeOvenTask("bake_b")];
		const graph: TaskGraph = {
			recipe_id: "r1",
			meal_id: "m1",
			tasks,
			critical_path_min: 32,
			total_active_min: 4,
			total_passive_min: 60,
			parallelism_max: 2,
		};
		const members: BrigadeMember[] = [
			{ member_id: "alice", skills: { oven_basic: 0.8 }, presence: "in_kitchen_idle" },
			{ member_id: "bob",   skills: { oven_basic: 0.6 }, presence: "in_kitchen_idle" },
		];

		// 1. Same-tick exclusivity: both members eligible, but only one
		//    can claim the oven.
		const tick1 = tickScheduler({
			graph,
			members,
			completed_task_ids: new Set(),
			in_flight_assignments: [],
			now_ms: NOW,
			equipment_defs: [{ slug: "oven", exclusive: true, capacity: 1 }],
		});
		ctx.assert.eq(tick1.new_assignments.length, 1, "exclusive oven → only one assignment in this tick");
		ctx.assert.eq(tick1.unassignable_tasks.length, 0, "the second task IS assignable, just paced");

		// 2. Default equipment def absent → still defaults to exclusive.
		const tick2 = tickScheduler({
			graph,
			members,
			completed_task_ids: new Set(),
			in_flight_assignments: [],
			now_ms: NOW,
		});
		ctx.assert.eq(tick2.new_assignments.length, 1, "missing def defaults to exclusive");

		// 3. Outside claim on oven: NO oven task assignable.
		const tick3 = tickScheduler({
			graph,
			members,
			completed_task_ids: new Set(),
			in_flight_assignments: [],
			now_ms: NOW,
			equipment_defs: [{ slug: "oven", exclusive: true, capacity: 1 }],
			current_equipment_claims: [{
				slug: "oven",
				start_ts: NOW - 10 * 60_000,
				end_ts: NOW + 30 * 60_000,
				claim_for_id: "other_meal",
			}],
		});
		ctx.assert.eq(tick3.new_assignments.length, 0, "external oven claim blocks all oven tasks");
		ctx.assert.eq(tick3.unassignable_tasks.length, 2, "both ready tasks reported as unassignable (no candidates)");

		// 4. Outside claim has already expired → tasks assignable again.
		const tick4 = tickScheduler({
			graph,
			members,
			completed_task_ids: new Set(),
			in_flight_assignments: [],
			now_ms: NOW,
			equipment_defs: [{ slug: "oven", exclusive: true, capacity: 1 }],
			current_equipment_claims: [{
				slug: "oven",
				start_ts: NOW - 60 * 60_000,
				end_ts: NOW - 1_000,
				claim_for_id: "other_meal",
			}],
		});
		ctx.assert.eq(tick4.new_assignments.length, 1, "expired claim doesn't block");
	},
};

export default u64;
