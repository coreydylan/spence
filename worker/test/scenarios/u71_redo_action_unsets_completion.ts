// U71 — Redo action un-sets task completion.
//
// When the vision model returns iteration_suggestion.action === "redo",
// the photo-handler's plan must:
//   1. Set update_assignment_iteration=true with a "[redo]" note.
//   2. Set uncomplete_task=true (so the DO drops completed_at_ms / outcome
//      and the scheduler re-queues the task).
//   3. Set broadcast_iteration=true.
//
// We also assert the inverse: every other action keeps uncomplete_task=false,
// so a "wait" suggestion never accidentally rolls back a completed task.
//
// Finally we drive `planVisionApply` against a fixture vision response that
// mimics what the bridge would return after seeing uneven dice — the
// pipeline must produce a redo plan with the right note + action.

import type { Scenario } from "../lib/types";
import { planVisionApply } from "../../src/mise-graph/agents/photo-handler";
import { normalizeAnalysis, type VisionAnalysis } from "../../src/mise-graph/bridge-vision";

const u71: Scenario = {
	id: "u71",
	name: "Redo action un-sets completion; other actions don't",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// 1. Redo plan sets uncomplete_task.
		const redoAnalysis: VisionAnalysis = {
			on_track: false,
			confidence: 0.88,
			observed: "pieces are uneven — some 1/4 inch, some doubled-up",
			concerns: ["uniformity"],
			iteration_suggestion: {
				action: "redo",
				detail: "redo the dice — pieces are uneven, target 1/4 inch",
			},
		};
		const redoPlan = planVisionApply(redoAnalysis);
		ctx.assert.eq(redoPlan.iteration_action, "redo", "action=redo");
		ctx.assert.ok(redoPlan.uncomplete_task, "redo flips uncomplete_task=true");
		ctx.assert.ok(redoPlan.update_assignment_iteration, "redo updates assignment note");
		ctx.assert.ok(redoPlan.broadcast_iteration, "redo broadcasts iteration");
		ctx.assert.contains(
			redoPlan.iteration_note || "",
			"[redo]",
			"iteration_note tagged with [redo]",
		);

		// 2. None of the other actions un-complete.
		const nonRedoActions: VisionAnalysis["iteration_suggestion"][] = [
			{ action: "wait", detail: "+30s" },
			{ action: "add_ingredient", detail: "needs water", ingredient_to_add: { name: "water", qty: 1, unit: "tbsp" } },
			{ action: "adjust_temp", detail: "drop heat", temp_adjust_pct: -20 },
			{ action: "stop_now", detail: "done" },
		];
		for (const sug of nonRedoActions) {
			if (!sug) continue;
			const plan = planVisionApply({
				on_track: false,
				confidence: 0.7,
				observed: "stuff",
				concerns: [],
				iteration_suggestion: sug,
			});
			ctx.assert.ok(
				!plan.uncomplete_task,
				`action=${sug.action} does NOT un-complete`,
			);
			ctx.assert.eq(plan.iteration_action, sug.action, `action=${sug.action} surfaced`);
		}

		// 3. on_track + no suggestion → no un-complete (sanity).
		const okPlan = planVisionApply({
			on_track: true,
			confidence: 0.99,
			observed: "perfect",
			concerns: [],
		});
		ctx.assert.ok(!okPlan.uncomplete_task, "ok plan never un-completes");
		ctx.assert.ok(!okPlan.broadcast_iteration, "ok plan never broadcasts iteration");

		// 4. Bridge fixture: a JSON envelope shaped like the bridge would return
		//    after seeing uneven dice. normalizeAnalysis → planVisionApply →
		//    expected redo plan.
		const bridgeFixture = {
			analysis: {
				on_track: false,
				confidence: 0.91,
				observed: "Pieces are visibly uneven — about 60% 1/4-inch, the rest much smaller fragments and a few oversized stragglers.",
				concerns: ["non-uniform sizing", "torn edges on the larger pieces"],
				iteration_suggestion: {
					action: "redo",
					detail: "Redo the dice — keep the knife heel anchored and use the rocking motion. Target 1/4-inch.",
				},
			},
		};
		const fixtureAnalysis = normalizeAnalysis(bridgeFixture.analysis);
		ctx.assert.ok(!!fixtureAnalysis, "bridge fixture parses");
		if (!fixtureAnalysis) return;

		const fixturePlan = planVisionApply(fixtureAnalysis);
		ctx.assert.eq(fixturePlan.iteration_action, "redo", "fixture → redo");
		ctx.assert.ok(fixturePlan.uncomplete_task, "fixture redo un-completes");
		ctx.assert.contains(
			fixturePlan.iteration_note || "",
			"1/4-inch",
			"fixture note carries the size target",
		);

		// 5. Simulate the DO's UPDATE that would re-flag the task. We use a
		//    Map<task_id, {completed_at_ms, outcome}> as the in-memory
		//    assignment table; the DO does the same with embedded SQLite.
		interface Assignment {
			task_id: string;
			member_id: string;
			completed_at_ms: number | null;
			outcome: string | null;
			iteration_note: string | null;
		}
		const assignments = new Map<string, Assignment>();
		const TASK_ID = "task_dice_onion";
		const MEMBER_ID = "mem_alice";
		assignments.set(`${TASK_ID}/${MEMBER_ID}`, {
			task_id: TASK_ID,
			member_id: MEMBER_ID,
			completed_at_ms: 1_750_000_000_000,
			outcome: "succeeded",
			iteration_note: null,
		});

		// Apply the plan's mutations.
		const before = assignments.get(`${TASK_ID}/${MEMBER_ID}`)!;
		ctx.assert.notEq(before.completed_at_ms, null, "task starts completed");

		// The DO's logic: when uncomplete_task is true, drop the completion;
		// when update_assignment_iteration is true, write the note.
		if (fixturePlan.uncomplete_task) {
			const row = assignments.get(`${TASK_ID}/${MEMBER_ID}`)!;
			row.completed_at_ms = null;
			row.outcome = null;
		}
		if (fixturePlan.update_assignment_iteration && fixturePlan.iteration_note) {
			const row = assignments.get(`${TASK_ID}/${MEMBER_ID}`)!;
			row.iteration_note = fixturePlan.iteration_note;
		}

		const after = assignments.get(`${TASK_ID}/${MEMBER_ID}`)!;
		ctx.assert.eq(after.completed_at_ms, null, "redo cleared completed_at_ms");
		ctx.assert.eq(after.outcome, null, "redo cleared outcome");
		ctx.assert.notEq(after.iteration_note, null, "redo set iteration_note");
		ctx.assert.contains(after.iteration_note || "", "[redo]", "note has [redo] tag");

		// 6. Test the inverse: a wait suggestion does NOT clear a completed task.
		const completed: Assignment = {
			task_id: "task_other",
			member_id: MEMBER_ID,
			completed_at_ms: 1_750_000_000_000,
			outcome: "succeeded",
			iteration_note: null,
		};
		const waitPlan = planVisionApply({
			on_track: true,
			confidence: 0.8,
			observed: "almost there",
			concerns: [],
			iteration_suggestion: { action: "wait", detail: "+30s" },
		});
		if (waitPlan.uncomplete_task) {
			completed.completed_at_ms = null;
		}
		ctx.assert.notEq(
			completed.completed_at_ms,
			null,
			"wait DOES NOT touch completed_at_ms",
		);
	},
};

export default u71;
