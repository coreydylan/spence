// Phase 2 — CookSessionDebriefWorkflow.
//
// Auto-spawned by `MealAgent.applyPhaseStateHooks` when a meal transitions
// to `eaten`. The workflow waits ~30 minutes (giving the household time to
// actually finish dinner), asks for a 1-5 taste rating + optional notes,
// persists the rating, then folds the rating back into the household's
// trait engine via `household_observe_response`.
//
// Trigger:
//   await env.COOK_DEBRIEF_WORKFLOW.create({
//     id: cook_session_id,
//     params: { meal_id, plan_id, household_id, ... }
//   });
//
// Resume: the chat surface POSTs to
//   /agent/workflow/cook_debrief/<cook_session_id>/events
// with `{ type: "meal_rating", payload: { score, would_repeat?, finished?,
// notes?, format?, cuisine?, title? } }`.
//
// We use household_observe_response (a real registered MCP tool) to
// persist the rating signal; loved meals push `comfort_vs_adventure` and
// related traits, rejected meals do the inverse. The full denorm row in
// `mise_meal_feedback` is written by the `recordMealFeedback` helper —
// when that path becomes a registered MCP tool we'll call it directly,
// for now the observation pipeline carries the signal forward.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { recordMealFeedback, type MealRating } from "../mise-graph/recipe-feedback";
import { asSleepDuration, bindMcp, relaxStep, workflowCallerId } from "./runner-helpers";

export interface CookDebriefParams {
	cook_session_id: string;
	meal_id: string;
	plan_id: string;
	household_id: string;
	// Optional denorm fields the workflow forwards into the rating row.
	meal_date?: string;
	meal_slot?: string;
	meal_title?: string;
	meal_cuisine?: string[];
	meal_format?: string;
	meal_anchors?: string[];
	// Test/dev override — defaults to "30 minutes" / "24 hours".
	post_meal_delay?: string;
	rating_timeout?: string;
}

export interface MealRatingEvent {
	score: 1 | 2 | 3 | 4 | 5;
	would_repeat?: boolean;
	finished?: boolean;
	notes?: string;
	// Denorm overrides — when the user surfaces details inline (e.g.
	// "the cuisine was wrong"), the chat layer can include them.
	format?: string;
	cuisine?: string;
	title?: string;
}

export interface CookDebriefResult {
	cook_session_id: string;
	meal_id: string;
	rating: number | null;
	skipped: boolean;
	observed: "loved" | "rejected" | "neutral" | null;
}

export class CookSessionDebriefWorkflow extends WorkflowEntrypoint<Cloudflare.Env, CookDebriefParams> {
	async run(event: WorkflowEvent<CookDebriefParams>, step: WorkflowStep): Promise<CookDebriefResult> {
		const params = event.payload;
		const {
			cook_session_id,
			meal_id,
			plan_id,
			household_id,
		} = params;

		const mcp = bindMcp(this.env, {
			caller_kind: "system",
			caller_id: workflowCallerId("cook_debrief", cook_session_id),
		});
		const s = relaxStep(step);

		// ── Step 1: post-meal delay ─────────────────────────────────────
		// 30 min default — give the household time to finish eating
		// before we ping. step.sleep is durable: the worker hibernates
		// during the wait.
		await s.sleep("wait_for_post_meal", asSleepDuration(params.post_meal_delay ?? "30 minutes"));

		// ── Step 2: ask for taste rating ────────────────────────────────
		// The chat surface renders the rating prompt by polling
		// /agent/workflow/cook_debrief/<id>/status. When the user
		// answers, the web client POSTs the event and we resume here.
		let rating: MealRatingEvent | null = null;
		try {
			const evt = await s.waitForEvent<MealRatingEvent>("rating", {
				type: "meal_rating",
				timeout: params.rating_timeout ?? "24 hours",
			});
			rating = evt.payload;
		} catch {
			// Timeout — household didn't rate. That's a signal in itself
			// (low engagement); record nothing and exit.
			return {
				cook_session_id,
				meal_id,
				rating: null,
				skipped: true,
				observed: null,
			};
		}

		// ── Step 3: persist the rating row ──────────────────────────────
		// recordMealFeedback writes mise_meal_feedback so future composer
		// runs see the loved/rejected signal via mealFeedbackHints.
		await s.do("record_rating", async () => {
			await recordMealFeedback(this.env, {
				household_id,
				plan_id,
				meal_id,
				rating: clampRating(rating!.score),
				would_repeat: rating!.would_repeat,
				finished: rating!.finished,
				notes: rating!.notes,
				meal_date: params.meal_date,
				meal_slot: params.meal_slot,
				meal_title: rating!.title ?? params.meal_title,
				meal_cuisine: rating!.cuisine ? [rating!.cuisine] : params.meal_cuisine,
				meal_format: rating!.format ?? params.meal_format,
				meal_anchors: params.meal_anchors,
			});
			return { ok: true };
		});

		// ── Step 4: fold into trait engine ──────────────────────────────
		const score = rating.score;
		let observed: CookDebriefResult["observed"] = "neutral";
		if (score >= 4) {
			observed = "loved";
			await s.do("observe_love", () => {
				const format = rating!.format ?? params.meal_format ?? "meal";
				const cuisine = rating!.cuisine ?? (params.meal_cuisine?.[0] ?? "this");
				return mcp("household_observe_response", {
					household_id,
					observation_kind: "meal_loved",
					observation_text: `loved ${cuisine} ${format}`,
					inferred_traits: [
						{
							trait_name: "comfort_vs_adventure",
							delta_value: 0.3,
							delta_confidence: 0.1,
						},
					],
				});
			});
		} else if (score <= 2) {
			observed = "rejected";
			await s.do("observe_reject", () => {
				const format = rating!.format ?? params.meal_format ?? "meal";
				const cuisine = rating!.cuisine ?? (params.meal_cuisine?.[0] ?? "this");
				return mcp("household_observe_response", {
					household_id,
					observation_kind: "meal_rejected",
					observation_text: `rejected ${cuisine} ${format}`,
					inferred_traits: [
						{
							trait_name: "comfort_vs_adventure",
							delta_value: -0.3,
							delta_confidence: 0.1,
						},
					],
				});
			});
		}

		return {
			cook_session_id,
			meal_id,
			rating: score,
			skipped: false,
			observed,
		};
	}
}

function clampRating(value: number): MealRating {
	const n = Math.round(Number(value));
	if (n <= 1) return 1;
	if (n >= 5) return 5;
	return n as MealRating;
}
