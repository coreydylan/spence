// U67 — Brigade scheduler: completion-check based on task duration.
//
// In-flight assignment whose started_at_ms + (active+passive)*60s has
// elapsed should appear in `ready_for_completion_check` so the DO prompts
// the member to confirm they're done. Tasks still within their expected
// budget should NOT be flagged.

import type { Scenario } from "../lib/types";
import { tickScheduler } from "../../src/mise-graph/agents/cooking-lead-scheduler";
import type {
	BrigadeMember,
	BrigadeSchedulerInput,
	InFlightAssignment,
} from "../../src/mise-graph/agents/cooking-lead-types";
import type { TaskGraph, TaskNode } from "../../src/mise-graph/task-graph-types";

const NOW = 1_750_000_000_000;

function makeTask(id: string, active_min: number, passive_min: number): TaskNode {
	return {
		id,
		recipe_id: "r1",
		step_idx: 0,
		kind: "prep",
		label: id,
		skill: "knife_basic",
		skill_floor: 0.3,
		equipment: [],
		ingredients_in: [],
		produces: id,
		active_min,
		passive_min,
		parallelizable: true,
		depends_on: [],
	};
}

const u67: Scenario = {
	id: "u67",
	name: "Brigade scheduler: completion check uses task duration when known",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// Quick task: 5min active. After 6min in-flight, it should be flagged.
		const quickTask = makeTask("quick", 5, 0);
		// Long task: 15min active + 30min passive. Even at 10min in, NOT flagged.
		const longTask = makeTask("bake", 15, 30);

		const graph: TaskGraph = {
			recipe_id: "r1",
			meal_id: "m1",
			tasks: [quickTask, longTask],
			critical_path_min: 45,
			total_active_min: 20,
			total_passive_min: 30,
			parallelism_max: 2,
		};

		const alice: BrigadeMember = {
			member_id: "alice",
			skills: { knife_basic: 0.8 },
			presence: "in_kitchen_idle",
		};

		const inFlight: InFlightAssignment[] = [
			// Started 6 minutes ago, expected 5 → ELAPSED.
			{
				task_id: "quick",
				member_id: "alice",
				started_at_ms: NOW - 6 * 60_000,
				assigned_at_ms: NOW - 6 * 60_000,
			},
			// Started 10 minutes ago, expected 45 → not elapsed.
			{
				task_id: "bake",
				member_id: "alice",
				started_at_ms: NOW - 10 * 60_000,
				assigned_at_ms: NOW - 10 * 60_000,
			},
		];

		const out = tickScheduler({
			graph,
			members: [alice],
			completed_task_ids: new Set(),
			in_flight_assignments: inFlight,
			now_ms: NOW,
		});

		ctx.assert.eq(out.ready_for_completion_check.length, 1, "exactly one stale in-flight task");
		ctx.assert.eq(out.ready_for_completion_check[0], "quick", "the elapsed task is flagged");

		// Edge: in-flight assignment with no started_at_ms but assigned 6min
		// ago — fall back to assigned_at_ms.
		const inFlight2: InFlightAssignment[] = [{
			task_id: "quick",
			member_id: "alice",
			started_at_ms: null,
			assigned_at_ms: NOW - 6 * 60_000,
		}];
		const out2 = tickScheduler({
			graph,
			members: [alice],
			completed_task_ids: new Set(),
			in_flight_assignments: inFlight2,
			now_ms: NOW,
		});
		ctx.assert.eq(out2.ready_for_completion_check.length, 1, "fallback to assigned_at_ms when started missing");

		// Edge: task NOT in graph (unknown duration) → falls back to 30min stale.
		const orphanInFlight: InFlightAssignment[] = [{
			task_id: "ghost_task_not_in_graph",
			member_id: "alice",
			started_at_ms: NOW - 31 * 60_000,
			assigned_at_ms: NOW - 31 * 60_000,
		}];
		const out3 = tickScheduler({
			graph,
			members: [alice],
			completed_task_ids: new Set(),
			in_flight_assignments: orphanInFlight,
			now_ms: NOW,
		});
		ctx.assert.eq(out3.ready_for_completion_check.length, 1, "unknown task uses 30-min fallback stale");
	},
};

export default u67;
