# Onboarding Phase D — Implementation Report

## Question banks added

* **Tier 2 (6 questions)** — `TIER_2_QUESTIONS`. All `HookedQuestion`. Triggers: `skipped_meal`, `cuisine_streak`, `anchor_repeat`, `equipment_unused`, `weekend_food`, `takeout_night`. Each carries a `text_template` rendered against `HookDeps` at ask-time.
* **Tier 3 (10 questions)** — `TIER_3_QUESTIONS`. Opportunistic, calendar-gated. Triggers: `tired_night_default`, `sunday_morning`, `loved_meal_followup`, `holiday_approach`, `cancel_alternative`, `perfect_on_paper`, `growing_up_meal`, `cook_alone_or_together`, `leftover_philosophy`, `tired_response_pattern`. Two carry inferred-trait deltas (`solo_cook_vs_social_cook`).
* **Tier 4 (6 questions)** — `TIER_4_QUESTIONS`. Calendar-driven. Triggers: `season_summer / fall / winter / spring`, `new_member`, `hosting_uptick`.

`HookedQuestion` is a separate interface from Phase A's `Question` so `onboarding.ts` (locked) keeps its `tier: 0|1` typing. `getQuestionsForTier(0..4)` returns the right bank; `findHookedQuestion(kind)` and `findAnyQuestion(kind)` span both shapes.

## Hook predicates (`onboarding-hooks.ts`)

* `HookDeps` is a 22-field snapshot — calendar facts (is_weekend, is_sunday_morning, current_month, days_until_next_holiday), behavioral signals (recent_cancellations, dominant_cuisine_streak, repeat_ingredient + count, tired_mentions_recent, idle_equipment, new_member_recent), and the `engagement_signal` from Phase A state.
* `computeHookDeps(env, household_id, now_ms)` reads onboarding-state, response log, equipment_json from profile, members table, and probes optional Phase-C tables (`mise_meal_cancellations`, `mise_meal_signals`, `mise_equipment_claims`) — every read is in a `try/catch` so missing tables degrade to zero rather than throw. Holiday lookahead uses a 7-entry hard-coded month/day list within ±30 days.
* `evaluateHook(question, deps)` returns `{fires, bonus: 1.5 | 1.0, rendered_text}`. Non-hooked Question always returns `fires=true, bonus=1.0`. Trigger evaluator is a single switch on `TriggerKind`. Template renderer (`renderTemplate`) walks `${var}` patterns with a 22-key map and silently swallows missing keys.

## Multi-member trait spread (`onboarding-trait-spread.ts`)

* `getHouseholdTraitSpread(env, household_id)` reads `mise_household_traits` rows for both `member_id IS NULL` (household-level) and per-member rows. Aggregates per trait into `TraitSpread { household_value, household_confidence, member_values[], divergence, status, description }`.
* Divergence = `max(value) - min(value)` across members; `> 0.4` → `"diverging"`, `≤ 0.4` with 2+ calibrated members → `"aligned"`, otherwise `"uncalibrated"`.
* Description renders via `TRAIT_POLES` (e.g. `comfort_vs_adventure → comfort | adventure`). Diverging shape: "Corey leans comfort (0.20), Katrina leans adventure (0.85). Try alternating or splitting the dishes." — pulls display names from `mise_household_members`.
* Wired through MCP as `household_get_trait_spread { household_id }`.

## Chattiness filter

`applyChattinessFilter(questions, engagement_signal)` returns `{allowed, gated, max_questions: 1|2}`. `< 0.7` strips tier 3/4; `≥ 1.4` allows max 2 questions per brief; default = 1, all tiers. NaN coerces to default. Sibling helper to Phase C's `pickQuestionForBrief`; chains via the caller before scoring.

## Test results

`npm test` → **118 / 118 pass**. `npx tsc --noEmit` clean. `wrangler --dry-run` clean.

* `u96` (52 assertions) — tier 2 question shape, `computeHookDeps` baseline + idle-equipment surface, `cuisine_streak`/`anchor_repeat`/`equipment_unused` fire with bonus 1.5 and templated text.
* `u97` (34 assertions) — Sunday tradition silent on Thursday and Sunday evening, fires only Sun 06–12 UTC; Thanksgiving holiday trigger 3 days out; tired-mention parsed from response log; `loved_meal_followup` template-renders the meal label.
* `u98` (26 assertions) — empty → []; household-only → uncalibrated; per-member injection (Corey 0.20, Katrina 0.85) → diverging with named description; pulling Katrina to 0.30 → aligned with mean 0.25; MCP tool round-trips via `handlePlanWorldJsonRpc`.
* `u99` (18 assertions) — terse (0.5) gates 16 of 32 (every gated entry tier ≥ 3); default (1.0) all 32 + max=1; chatty (1.6) all 32 + max=2; boundaries 0.7 and 1.4 land on the right side; NaN → default.

## Coordination notes

* Phase B's `getTraits` already returns the 7-dimension household-level snapshot; `household_get_trait_spread` is the richer multi-member view (divergence + per-member).
* `mise_household_traits` PK is `(household_id, trait_name)` — the schema doesn't yet allow multiple per-member rows. The Phase D reader handles both shapes; per-member rows in `u98` are injected via `__tables()` so we exercise the path that lights up once Phase B extends the schema.
* `plan-world-mcp.ts` edits are additive (one new `case`, one new `tool(...)` schema, one new `import`). No Phase B / C cases were touched.
