// U94 — Behavioral observation pipeline → trait inference.
//
// Confirms:
//   * household_observe_response writes a synthetic mise_onboarding_responses
//     row with question_kind=`_observed:<kind>` and the observation text.
//   * meal_cancelled within 2h of cook_window pushes quick_vs_project ↑.
//   * ingredient_swap pushes precision_vs_improvisation ↑.
//   * meal_composed with repeat_count=3 pushes comfort_vs_adventure ↓.
//   * Observation log entries are durable across multiple calls.

import type { Scenario } from "../lib/types";
import { createMockD1 } from "../lib/mock-d1";
import { migrateHouseholdMemorySchema } from "../../src/mise-graph/admin-household-memory";
import { migrateOnboardingSchema } from "../../src/mise-graph/schemas/migrations";
import {
	listResponses,
	listTraits,
	startOnboarding,
} from "../../src/mise-graph/onboarding";
import {
	inferTraitsFromObservation,
	observeResponse,
} from "../../src/mise-graph/onboarding-observe";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

const u94: Scenario = {
	id: "u94",
	name: "Observation pipeline writes synthetic responses + updates traits",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const db = createMockD1();
		const env = { DB: db as unknown as D1Database } as MiseGraphEnv;
		await migrateHouseholdMemorySchema(env);
		await migrateOnboardingSchema(env);
		await startOnboarding(env, { household_id: "hh_u94" });

		// 0. Pure rule-table sanity (no I/O): each rule produces the right delta.
		const cancelDeltas = inferTraitsFromObservation("meal_cancelled", "no time", { cancel_within_2h: true });
		ctx.assert.eq(cancelDeltas.length, 1, "meal_cancelled within 2h fires one delta");
		ctx.assert.eq(cancelDeltas[0].trait_name, "quick_vs_project", "meal_cancelled targets quick_vs_project");
		ctx.assert.eq(cancelDeltas[0].delta_value, 1.0, "delta_value points to quick end (1.0)");
		ctx.assert.gte(cancelDeltas[0].delta_confidence, 0.15, "within-2h cancel emits ≥0.15 confidence");

		const swapDeltas = inferTraitsFromObservation("ingredient_swap", "olive oil → ghee", {});
		ctx.assert.eq(swapDeltas.length, 1, "ingredient_swap fires one delta");
		ctx.assert.eq(swapDeltas[0].trait_name, "precision_vs_improvisation", "ingredient_swap targets precision_vs_improvisation");
		ctx.assert.eq(swapDeltas[0].delta_value, 1.0, "swap moves toward improvisation (1.0)");

		const repeatDeltas = inferTraitsFromObservation("meal_composed", "format=bowl cuisine=med people=2", { repeat_count: 3 });
		ctx.assert.eq(repeatDeltas.length, 1, "compose with repeat_count=3 fires one delta");
		ctx.assert.eq(repeatDeltas[0].trait_name, "comfort_vs_adventure", "repeat targets comfort_vs_adventure");
		ctx.assert.eq(repeatDeltas[0].delta_value, 0.0, "repeat moves toward comfort (0.0)");

		const noRepeatDeltas = inferTraitsFromObservation("meal_composed", "format=bowl", { repeat_count: 1 });
		ctx.assert.eq(noRepeatDeltas.length, 0, "compose with repeat_count=1 emits no delta");

		// 1. observeResponse: meal_cancelled within 2h → quick_vs_project ↑.
		const cancelResult = await observeResponse(env, {
			household_id: "hh_u94",
			observation_kind: "meal_cancelled",
			observation_text: "no time tonight",
			context: { cancel_within_2h: true },
		});
		ctx.assert.eq(cancelResult.recorded, true, "cancel observation recorded");
		ctx.assert.eq(cancelResult.traits_updated, 1, "one trait updated (quick_vs_project)");
		ctx.assert.eq(cancelResult.deltas[0].trait_name, "quick_vs_project", "delta targets quick_vs_project");
		ctx.assert.gt(cancelResult.deltas[0].new_value, 0.5, "trait moved toward 1.0 (quick end) — i.e. > 0.5");

		// 2. observeResponse: ingredient_swap → precision_vs_improvisation ↑.
		const swapResult = await observeResponse(env, {
			household_id: "hh_u94",
			observation_kind: "ingredient_swap",
			observation_text: "olive oil→ghee",
		});
		ctx.assert.eq(swapResult.traits_updated, 1, "swap updates one trait");
		ctx.assert.eq(swapResult.deltas[0].trait_name, "precision_vs_improvisation", "swap targets precision_vs_improvisation");
		ctx.assert.gt(swapResult.deltas[0].new_value, 0.5, "trait moved toward 1.0 (improvisation end)");

		// 3. observeResponse: meal_composed with repeat_count=3 → comfort_vs_adventure ↓.
		const composeResult = await observeResponse(env, {
			household_id: "hh_u94",
			observation_kind: "meal_composed",
			observation_text: "format=bowl cuisine=med people=2",
			context: { repeat_count: 3 },
		});
		ctx.assert.eq(composeResult.traits_updated, 1, "compose-with-repeat updates one trait");
		ctx.assert.eq(composeResult.deltas[0].trait_name, "comfort_vs_adventure", "compose-with-repeat targets comfort_vs_adventure");
		ctx.assert.ok(composeResult.deltas[0].new_value < 0.5, "trait moved toward 0.0 (comfort end)");

		// 4. Synthetic responses are appended to the log with `_observed:` prefix.
		const responses = await listResponses(env, "hh_u94");
		const observed = responses.filter(r => r.question_kind.startsWith("_observed:"));
		ctx.assert.gte(observed.length, 3, "≥3 observation rows logged (cancel/swap/compose)");
		const cancelRow = observed.find(r => r.question_kind === "_observed:meal_cancelled");
		ctx.assert.ok(!!cancelRow, "cancel row present");
		ctx.assert.eq(cancelRow!.response_text, "no time tonight", "cancel observation_text round-trips");
		ctx.assert.eq(cancelRow!.tier, -1, "observation rows use sentinel tier=-1");

		// 5. Trait persistence: traits table contains the updated values.
		const traits = await listTraits(env, "hh_u94");
		const quick = traits.find(t => t.trait_name === "quick_vs_project");
		const precision = traits.find(t => t.trait_name === "precision_vs_improvisation");
		const comfort = traits.find(t => t.trait_name === "comfort_vs_adventure");
		ctx.assert.ok(!!quick, "quick_vs_project persisted");
		ctx.assert.ok(!!precision, "precision_vs_improvisation persisted");
		ctx.assert.ok(!!comfort, "comfort_vs_adventure persisted");
		ctx.assert.eq(quick!.evidence_count, 1, "quick has 1 evidence");
		ctx.assert.gt(quick!.confidence, 0, "quick confidence > 0");
		ctx.assert.gt(precision!.confidence, 0, "precision confidence > 0");
		ctx.assert.gt(comfort!.confidence, 0, "comfort confidence > 0");

		// 6. Caller-supplied inferred_traits override the rule table.
		const overrideResult = await observeResponse(env, {
			household_id: "hh_u94",
			observation_kind: "custom_event",
			observation_text: "agent classified this directly",
			inferred_traits: [{
				trait_name: "ritual_vs_refueling",
				delta_value: 0.0,
				delta_confidence: 0.1,
			}],
		});
		ctx.assert.eq(overrideResult.traits_updated, 1, "explicit deltas override rule table");
		ctx.assert.eq(overrideResult.deltas[0].trait_name, "ritual_vs_refueling", "override targets the requested trait");

		ctx.notes.push(`u94 quick_vs_project after one within-2h cancel: ${quick!.trait_value} conf=${quick!.confidence}`);
	},
};

export default u94;
