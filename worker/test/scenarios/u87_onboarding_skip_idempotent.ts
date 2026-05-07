// U87 — Skip semantics + idempotent start.
//
// Confirms:
//   * Calling start twice on the same household_id returns the same state row
//     and does not reset progress.
//   * skip writes a response row with response_text=null and increments
//     skipped_count.
//   * Skipping a REQUIRED tier-0 question does NOT advance the tier — only
//     answering it (or its successor) can.
//   * Skipping an OPTIONAL question still allows tier advancement when the
//     other required answers are in place.

import type { Scenario } from "../lib/types";
import { createMockD1 } from "../lib/mock-d1";
import { migrateHouseholdMemorySchema } from "../../src/mise-graph/admin-household-memory";
import { migrateOnboardingSchema } from "../../src/mise-graph/schemas/migrations";
import {
	answerOnboarding,
	listResponses,
	skipOnboarding,
	startOnboarding,
} from "../../src/mise-graph/onboarding";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

const u87: Scenario = {
	id: "u87",
	name: "Onboarding skip behavior + idempotent start",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const db = createMockD1();
		const env = { DB: db as unknown as D1Database } as MiseGraphEnv;
		await migrateHouseholdMemorySchema(env);
		await migrateOnboardingSchema(env);

		// 1. Idempotent start.
		const first = await startOnboarding(env, { household_id: "hh_skip" });
		ctx.assert.eq(first.state.current_tier, 0, "first start returns tier 0");
		const firstUpdated = first.state.updated_at_ms;

		// Touch one answer so we can detect resets.
		await answerOnboarding(env, { household_id: "hh_skip", question_kind: "tier_0_size", response_text: "2" });

		const second = await startOnboarding(env, { household_id: "hh_skip" });
		ctx.assert.eq(second.state.current_tier, 0, "second start does not reset tier");
		ctx.assert.gte(second.state.questions_answered_count, 1, "second start preserves answered_count");
		ctx.assert.gte(second.state.updated_at_ms, firstUpdated, "second start updated_at is monotonic");

		// 2. Skip writes response_text=null and bumps skipped_count.
		const skipResult = await skipOnboarding(env, { household_id: "hh_skip", question_kind: "tier_0_household_name" });
		ctx.assert.eq(skipResult.recorded, true, "skip recorded");
		ctx.assert.eq(skipResult.state.questions_skipped_count, 1, "skipped_count incremented");

		const responses = await listResponses(env, "hh_skip");
		const skipRow = responses.find(r => r.question_kind === "tier_0_household_name");
		ctx.assert.ok(!!skipRow, "skip row exists in responses");
		ctx.assert.eq(skipRow!.response_text, null, "skipped row has response_text = null");
		ctx.assert.eq(skipRow!.response_chars, 0, "skipped row has response_chars = 0");

		// 3. Skipping a REQUIRED tier-0 question keeps you stuck on tier 0.
		// At this point we've answered tier_0_size and skipped tier_0_household_name (optional).
		// We need to skip a REQUIRED one and see we stay on tier 0.
		await skipOnboarding(env, { household_id: "hh_skip", question_kind: "tier_0_primary_member" });
		// Now answer the remaining required: tier_0_first_help (required).
		await answerOnboarding(env, { household_id: "hh_skip", question_kind: "tier_0_first_help", response_text: "meal_planning" });
		// tier_0_location is optional — skip it.
		await skipOnboarding(env, { household_id: "hh_skip", question_kind: "tier_0_location" });

		const stuck = await startOnboarding(env, { household_id: "hh_skip" });
		ctx.assert.eq(stuck.state.current_tier, 0, "still on tier 0 because tier_0_primary_member (required) was skipped, not answered");

		// 4. Skipping an OPTIONAL question allows advancement once the
		// required ones are answered. Answer the previously skipped required.
		await answerOnboarding(env, { household_id: "hh_skip", question_kind: "tier_0_primary_member", response_text: "Corey, adult" });

		const advanced = await startOnboarding(env, { household_id: "hh_skip" });
		ctx.assert.eq(advanced.state.current_tier, 1, "tier advances once all required tier-0 answers exist (optional skips are fine)");
		ctx.assert.ok(!!advanced.state.tier_0_completed_at, "tier_0_completed_at stamped");

		ctx.notes.push(`u87 final state: skipped=${advanced.state.questions_skipped_count}, answered=${advanced.state.questions_answered_count}`);
	},
};

export default u87;
