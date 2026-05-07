# Onboarding Phase C — Implementation Report

## Scheduler scoring

`worker/src/mise-graph/onboarding-scheduler.ts` — pure functions:

* `pickQuestionForBrief({state, recent_responses, available_questions, now_ms, engagement_signal, recent_activity_tokens?})` returns the top-scoring `ScheduledQuestion` or `null`.
* Score = `tier_weight × kind_priority × novelty_decay × hook_match_bonus × engagement_signal`.
  * `tier_weight = {0:1.0, 1:0.8, 2:0.5, 3:0.3, 4:0.4}`
  * `kind_priority = {dietary:1.2, equipment:1.0, tradition:0.9, personality:0.7}` — derived from question kind / text via regex (avoidance→dietary, etc.)
  * `novelty_decay = 1 - exp(-days/7)` (0 if never asked; 24h cooldown also suppresses).
  * `hook_match_bonus = 1.5` if a recent-activity token appears in the question text.
* Threshold: 0.3 default; 0.6 when engagement < 0.7 (terse).
* `detectSkipper()` — if response_rate < 0.2 over the last 10 surfaced questions, picker returns `null` (silence).
* `computeEngagementSignal(recent, now_ms)` clamps to `[0.5, 2.0]` per spec, with a 1h-to-24h linear cooldown decay on top.

## Observations wired

`worker/src/mise-graph/onboarding-observe.ts` exports `observeResponse` (MCP-public) and `observeFromTool` (try/catch wrapper for tool handlers).

In `plan-world-mcp.ts` the four write tools now fire-and-forget an observation:

| Tool | observation_kind | Trait delta |
|---|---|---|
| `plan_compose_meal` | `meal_composed` | `comfort_vs_adventure ↓` (only if `repeat_count ≥ 3`) |
| `plan_cancel_meal` | `meal_cancelled` | `quick_vs_project ↑` (conf 0.15 if `cancel_within_2h`, else 0.05) |
| `plan_swap_ingredient` | `ingredient_swap` | `precision_vs_improvisation ↑` (conf 0.15) |
| `plan_replace_meal` | `meal_replaced` | logged only |

Plus stubs for `brigade_mode_used` (Phase D) and `pantry_utilization_high` (Phase D) — rule table fires deltas; detection is deferred. `mark-eaten` hook deferred (lives behind the meal-agent DO route, which is off-limits per spec).

New MCP tools: `household_observe_response` + `household_get_next_question` (read-only preview; doesn't bump `last_question_asked_at`). HouseholdAgent's morning brief (`computeMorningBrief`) now calls `pickAndStampDailyQuestion` and surfaces an `onboarding_question` field on `MorningBriefResult`.

## Test results

`npm test` — **117 passed / 1 failed** (Phase B's u88 `replace_existing` bug is pre-existing, not mine — was failing on baseline). `npx tsc --noEmit` clean. `wrangler --dry-run` clean.

* `u92` — 13 assertions: top-pick selection, dietary > personality, cooldown, hook bonus.
* `u93` — 9 assertions: empty→1.0, chatty→2.0, terse→0.5, cooldown damping, terse threshold gating.
* `u94` — 34 assertions: rule table sanity, observation persistence, trait updates for cancel/swap/repeat, caller override.
* `u95` — 8 assertions: skipper requires ≥10 history, strict-less-than 0.2 boundary, picker silenced, recovery resumes.

Phase D tests u96–u99 (parallel agent) also pass — they read from the scheduler / observation pipeline this phase ships.
