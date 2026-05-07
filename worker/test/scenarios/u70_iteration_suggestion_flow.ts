// U70 — Iteration suggestion flow.
//
// Given a vision result with `iteration_suggestion`, the photo-handler's
// `planVisionApply` must emit a plan that:
//   1. Updates the assignment's iteration_note with composed text
//      ("[wait] sear is too pale — +90s").
//   2. Records the suggestion's action (wait/add_ingredient/.../redo).
//   3. Asks the caller to broadcast a `recipe_iteration_suggested` event.
//   4. Asks the caller to broadcast a `photo_analyzed` event regardless of
//      whether iteration was suggested.
//
// We also exercise the bridge-vision response normaliser so the
// VisionAnalysis envelope is valid input to the planner — even when the
// bridge returns partial / drifted shapes.

import type { Scenario } from "../lib/types";
import {
	planVisionApply,
	serialiseVisionResult,
} from "../../src/mise-graph/agents/photo-handler";
import {
	normalizeAnalysis,
	type VisionAnalysis,
	type VisionResult,
} from "../../src/mise-graph/bridge-vision";

const u70: Scenario = {
	id: "u70",
	name: "Iteration suggestion flow: vision → plan → assignment + broadcast",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// 1. Vision says "sear is too pale, wait 90s more".
		const waitAnalysis: VisionAnalysis = {
			on_track: true,
			confidence: 0.78,
			observed: "sear is pale on the visible side; some browning at edges",
			concerns: ["surface still shiny — collagen not melted yet"],
			iteration_suggestion: {
				action: "wait",
				detail: "let it go another 90 seconds",
				additional_min: 1.5,
			},
		};
		const waitPlan = planVisionApply(waitAnalysis);
		ctx.assert.ok(waitPlan.update_assignment_iteration, "wait → update assignment");
		ctx.assert.ok(waitPlan.broadcast_iteration, "wait → broadcast iteration");
		ctx.assert.ok(waitPlan.broadcast_photo_analyzed, "wait → broadcast photo analyzed");
		ctx.assert.ok(!waitPlan.uncomplete_task, "wait does NOT un-complete");
		ctx.assert.eq(waitPlan.iteration_action, "wait", "action=wait");
		ctx.assert.contains(waitPlan.iteration_note || "", "[wait]", "note has bracketed action");
		ctx.assert.contains(waitPlan.iteration_note || "", "90 seconds", "note has detail");
		ctx.assert.contains(waitPlan.iteration_note || "", "+1.5min", "note has +N min");

		// 2. Vision says "add 1tbsp water — dough's too dry".
		const addAnalysis: VisionAnalysis = {
			on_track: false,
			confidence: 0.85,
			observed: "shaggy dough with dry flour pockets at the bottom",
			concerns: ["needs more hydration"],
			iteration_suggestion: {
				action: "add_ingredient",
				detail: "dough is too dry",
				ingredient_to_add: { name: "water", qty: 1, unit: "tbsp" },
			},
		};
		const addPlan = planVisionApply(addAnalysis);
		ctx.assert.eq(addPlan.iteration_action, "add_ingredient", "action=add_ingredient");
		ctx.assert.contains(addPlan.iteration_note || "", "1 tbsp water", "note enumerates ingredient");
		ctx.assert.ok(!addPlan.uncomplete_task, "add_ingredient does NOT un-complete");

		// 3. adjust_temp → broadcast, no un-complete.
		const tempAnalysis: VisionAnalysis = {
			on_track: false,
			confidence: 0.7,
			observed: "fond is darkening fast",
			concerns: ["heat too high"],
			iteration_suggestion: {
				action: "adjust_temp",
				detail: "lower the heat",
				temp_adjust_pct: -25,
			},
		};
		const tempPlan = planVisionApply(tempAnalysis);
		ctx.assert.eq(tempPlan.iteration_action, "adjust_temp", "action=adjust_temp");
		ctx.assert.contains(tempPlan.iteration_note || "", "lower temp 25%", "note encodes magnitude");

		// 4. stop_now → broadcast iteration, no un-complete (cook decides).
		const stopAnalysis: VisionAnalysis = {
			on_track: false,
			confidence: 0.92,
			observed: "protein looks bone dry",
			concerns: ["already overcooked", "moisture clearly gone"],
			iteration_suggestion: {
				action: "stop_now",
				detail: "pull from heat now",
			},
		};
		const stopPlan = planVisionApply(stopAnalysis);
		ctx.assert.eq(stopPlan.iteration_action, "stop_now", "action=stop_now");
		ctx.assert.ok(!stopPlan.uncomplete_task, "stop_now does NOT un-complete");
		ctx.assert.ok(stopPlan.broadcast_iteration, "stop_now does broadcast");

		// 5. on_track + no suggestion → no iteration broadcast, just photo_analyzed.
		const okAnalysis: VisionAnalysis = {
			on_track: true,
			confidence: 0.95,
			observed: "deep golden crust, looks great",
			concerns: [],
		};
		const okPlan = planVisionApply(okAnalysis);
		ctx.assert.ok(!okPlan.update_assignment_iteration, "ok → no assignment update");
		ctx.assert.ok(!okPlan.broadcast_iteration, "ok → no iteration broadcast");
		ctx.assert.ok(okPlan.broadcast_photo_analyzed, "ok → still announces analysis");
		ctx.assert.eq(okPlan.iteration_action, null, "no iteration action");

		// 6. null analysis → safe no-op plan.
		const nullPlan = planVisionApply(null);
		ctx.assert.ok(!nullPlan.update_assignment_iteration, "null analysis → no assignment update");
		ctx.assert.ok(!nullPlan.broadcast_iteration, "null analysis → no iteration broadcast");
		ctx.assert.ok(nullPlan.broadcast_photo_analyzed, "null analysis → still announce (failure path)");
		ctx.assert.eq(nullPlan.iteration_action, null, "no action");

		// 7. normalizeAnalysis tolerates partial / drifted bridge responses.
		const driftedRaw = {
			on_track: "yes", // wrong type — should fall to default true
			confidence: 1.7, // out of range — clamped
			observed: "stuff",
			concerns: ["dry", 42, "too dark"], // 42 should be filtered out
			iteration_suggestion: {
				action: "redo",
				detail: "uneven cuts",
			},
		};
		const drifted = normalizeAnalysis(driftedRaw);
		ctx.assert.ok(!!drifted, "drifted analysis still parses");
		if (drifted) {
			ctx.assert.eq(drifted.on_track, true, "on_track defaults to true on bad type");
			ctx.assert.eq(drifted.confidence, 1, "confidence clamped to [0,1]");
			ctx.assert.eq(drifted.concerns.length, 2, "non-string concerns filtered");
			ctx.assert.eq(drifted.iteration_suggestion?.action, "redo", "redo action survives");
		}

		// Garbage normalize → null.
		ctx.assert.eq(normalizeAnalysis(null), null, "null raw → null");
		ctx.assert.eq(normalizeAnalysis("not an object"), null, "string raw → null");

		// 8. serialiseVisionResult drops raw_response by default.
		const fullResult: VisionResult = {
			ok: true,
			analysis: okAnalysis,
			raw_response: "lots of model text...",
			cost_usd: 0.0042,
			elapsed_ms: 1850,
		};
		const slim = serialiseVisionResult(fullResult);
		ctx.assert.ok(!slim.includes("lots of model text"), "raw_response stripped by default");
		const fat = serialiseVisionResult(fullResult, { include_raw: true });
		ctx.assert.contains(fat, "lots of model text", "raw_response included when asked");
	},
};

export default u70;
