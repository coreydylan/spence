// Phase 2 — OnboardingWorkflow.
//
// Replaces the chat-driven `chef_status_check` → `household_onboarding_answer`
// ping-pong with a durable Cloudflare Workflow that walks the user through:
//
//   1. Tier 0 — 5 questions (existence stub).
//   2. Tier 1 — 5 questions (day-1 essentials).
//   3. Bulk intake (optional) — gated on the user's `pantry_intake` answer.
//   4. Tier completion — emits a final `tier_1_complete` step so callers
//      can pick up the trail.
//
// The workflow's `id` is the `household_id` — one onboarding per
// household, idempotent. Calling `env.ONBOARDING_WORKFLOW.create({ id: hh,
// params: { household_id: hh } })` twice is safe; the second call gets a
// handle to the already-running instance.
//
// HTTP wiring: the web app POSTs to `/agent/workflow/onboarding/<hh>/events`
// with `{ type: "onboarding_answer", payload: { question_kind, response,
// skip? } }` and the worker forwards via
// `env.ONBOARDING_WORKFLOW.sendEvent(...)`. The next `step.waitForEvent`
// resumes with the payload.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
	TIER_0_QUESTIONS,
	TIER_1_QUESTIONS,
	type Question,
} from "../mise-graph/onboarding-questions";
import { bindMcp, relaxStep, workflowCallerId } from "./runner-helpers";

export interface OnboardingWorkflowParams {
	household_id: string;
	// Optional override. Real callers omit; tests can short-circuit the
	// 7-day waitForEvent timeout for faster runs.
	answer_timeout?: string;
}

export interface OnboardingAnswerEvent {
	question_kind: string;
	response_text?: string;
	skip?: boolean;
	member_id?: string;
}

export interface BulkIntakeEvent {
	mode: "text" | "photo" | "skip";
	text?: string;
	image_b64?: string;
}

export interface OnboardingWorkflowResult {
	household_id: string;
	tier_0_completed: boolean;
	tier_1_completed: boolean;
	bulk_intake_mode: "text" | "photo" | "gradual" | "skipped" | null;
	answers_recorded: number;
	skips: number;
}

export class OnboardingWorkflow extends WorkflowEntrypoint<Cloudflare.Env, OnboardingWorkflowParams> {
	async run(event: WorkflowEvent<OnboardingWorkflowParams>, step: WorkflowStep): Promise<OnboardingWorkflowResult> {
		const params = event.payload;
		const household_id = params.household_id;
		const answerTimeout = params.answer_timeout ?? "7 days";
		const s = relaxStep(step);

		const mcp = bindMcp(this.env, {
			caller_kind: "system",
			caller_id: workflowCallerId("onboarding", household_id),
		});

		// Track results across the run for the final summary.
		let answers_recorded = 0;
		let skips = 0;
		let bulk_intake_mode: OnboardingWorkflowResult["bulk_intake_mode"] = null;
		let pantry_intake_choice: string | null = null;

		// Step 0 — make sure the onboarding session exists. Idempotent on
		// the server side (household_onboarding_start no-ops on re-entry).
		await s.do("start_onboarding", async () => {
			return await mcp("household_onboarding_start", { household_id });
		});

		// ── Tier 0 — 5 questions ────────────────────────────────────────
		for (const q of TIER_0_QUESTIONS) {
			const result = await this.askQuestion(s, mcp, household_id, q, answerTimeout);
			if (result === "skipped") skips++;
			else if (result === "answered") answers_recorded++;
		}

		// Mark tier 0 complete in state. The status tool will surface this
		// to the chef next turn. The household_onboarding_answer handler
		// already advances tier when all required questions answer/skip,
		// so this step is mostly observational.
		const tier0Status = await s.do("read_tier_0_status", async () => {
			return await mcp("household_onboarding_status", { household_id });
		});
		const tier_0_completed = isTierComplete(tier0Status as Record<string, unknown>, 0);

		// ── Tier 1 — 5 questions ────────────────────────────────────────
		for (const q of TIER_1_QUESTIONS) {
			const result = await this.askQuestion(s, mcp, household_id, q, answerTimeout);
			if (result === "skipped") skips++;
			else if (result === "answered") {
				answers_recorded++;
			}
			// Track pantry_intake answer separately by re-reading status
			// (cheap, idempotent).
			if (q.kind === "tier_1_pantry_intake") {
				const refreshed = await s.do("snapshot_pantry_intake", async () => {
					return await mcp("household_onboarding_status", { household_id });
				});
				pantry_intake_choice = readPantryIntakeChoice(refreshed as Record<string, unknown>);
			}
		}

		// ── Bulk intake (optional) ──────────────────────────────────────
		// Only run the sub-flow when the user picked `bulk` or `photo`.
		// Gradual users get nothing here — the agent observes their
		// inventory as they cook.
		if (pantry_intake_choice === "bulk" || pantry_intake_choice === "photo") {
			let bulkEvt: { payload: BulkIntakeEvent } | null = null;
			try {
				bulkEvt = await s.waitForEvent<BulkIntakeEvent>("await_bulk_intake", {
					type: "bulk_intake",
					timeout: answerTimeout,
				});
			} catch {
				bulk_intake_mode = "skipped";
			}
			if (bulkEvt) {
				const payload = bulkEvt.payload;
				if (payload.mode === "skip" || (payload.mode !== "text" && payload.mode !== "photo")) {
					bulk_intake_mode = "skipped";
				} else {
					await s.do("apply_bulk_intake", async () => {
						return await mcp("household_set_pantry_bulk", {
							household_id,
							mode: payload.mode,
							text: payload.text,
							image_b64: payload.image_b64,
						});
					});
					bulk_intake_mode = payload.mode;
				}
			}
		} else if (pantry_intake_choice === "gradual") {
			bulk_intake_mode = "gradual";
		}

		// ── Final tier-completion snapshot ──────────────────────────────
		const finalStatus = await s.do("read_final_status", async () => {
			return await mcp("household_onboarding_status", { household_id });
		});
		const tier_1_completed = isTierComplete(finalStatus as Record<string, unknown>, 1);

		return {
			household_id,
			tier_0_completed,
			tier_1_completed,
			bulk_intake_mode,
			answers_recorded,
			skips,
		};
	}

	/**
	 * Ask a single question: surface it via household_onboarding_status (the
	 * web client polls this), then waitForEvent for the user's answer (or
	 * a skip), and persist via household_onboarding_answer / _skip.
	 *
	 * Returns "answered" | "skipped" | "timeout".
	 */
	private async askQuestion(
		s: ReturnType<typeof relaxStep>,
		mcp: (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>,
		household_id: string,
		q: Question,
		answerTimeout: string,
	): Promise<"answered" | "skipped" | "timeout"> {
		// Surface the question via the read-only status tool so the web
		// client knows what to render. The tool itself is idempotent —
		// calling it just tells the chef which question is "next."
		await s.do(`ask_${q.kind}`, async () => {
			return await mcp("household_onboarding_status", { household_id });
		});

		// Wait for the user's answer (or skip). The waitForEvent boundary
		// is what makes this workflow durable across days.
		let evt: { payload: OnboardingAnswerEvent } | null = null;
		try {
			evt = await s.waitForEvent<OnboardingAnswerEvent>(`answer_${q.kind}`, {
				type: "onboarding_answer",
				timeout: answerTimeout,
			});
		} catch {
			// Timeout — record a skip server-side so trait inference moves
			// on (no penalty), and surface the timeout up.
			await s.do(`timeout_${q.kind}`, async () => {
				return await mcp("household_onboarding_skip", {
					household_id,
					question_kind: q.kind,
				});
			});
			return "timeout";
		}

		const answer = evt.payload;
		if (answer.skip) {
			await s.do(`skip_${q.kind}`, async () => {
				return await mcp("household_onboarding_skip", {
					household_id,
					question_kind: q.kind,
					member_id: answer.member_id,
				});
			});
			return "skipped";
		}

		await s.do(`record_${q.kind}`, async () => {
			return await mcp("household_onboarding_answer", {
				household_id,
				question_kind: q.kind,
				response_text: answer.response_text ?? "",
				member_id: answer.member_id,
			});
		});
		return "answered";
	}
}

// ─── Status-shape helpers ───────────────────────────────────────────────────

function isTierComplete(status: Record<string, unknown>, tier: 0 | 1): boolean {
	const state = status?.state as Record<string, unknown> | undefined;
	if (!state) {
		// Newer status shapes nest under .onboarding; tolerate both.
		const nested = (status?.onboarding ?? status) as Record<string, unknown>;
		const v = nested?.[tier === 0 ? "tier_0_completed_at" : "tier_1_completed_at"];
		return typeof v === "string" && v.length > 0;
	}
	const key = tier === 0 ? "tier_0_completed_at" : "tier_1_completed_at";
	const v = state[key];
	return typeof v === "string" && v.length > 0;
}

function readPantryIntakeChoice(status: Record<string, unknown>): string | null {
	const responses = status?.responses as Array<Record<string, unknown>> | undefined;
	if (Array.isArray(responses)) {
		const row = responses.find(r => r?.question_kind === "tier_1_pantry_intake");
		if (row && typeof row.response_text === "string") {
			return normalizeChoice(row.response_text);
		}
	}
	// Older shapes expose the value directly on the profile.
	const profile = status?.profile as Record<string, unknown> | undefined;
	if (profile && typeof profile.pantry_intake_mode === "string") {
		return normalizeChoice(profile.pantry_intake_mode);
	}
	return null;
}

function normalizeChoice(s: string): string {
	return s.trim().toLowerCase();
}
