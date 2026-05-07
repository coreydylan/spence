# Phase 2 — Cloudflare Workflows for Onboarding + Planning + Cook Debrief

## Workflows shipped

### 1. `OnboardingWorkflow` (binding `ONBOARDING_WORKFLOW` / class `OnboardingWorkflow` / name `spence-onboarding`)

Instance id = `household_id` (idempotent). Per-question loop:
`step.do("ask_<kind>")` → `step.waitForEvent<OnboardingAnswerEvent>("answer_<kind>", { type: "onboarding_answer", timeout: "7 days" })` → `step.do("record_<kind>" | "skip_<kind>" | "timeout_<kind>")`. Iterates `TIER_0_QUESTIONS` then `TIER_1_QUESTIONS`. After tier 1, branches on `tier_1_pantry_intake` answer to optionally run a `bulk_intake` sub-flow that calls `household_set_pantry_bulk`. Returns `{ tier_0_completed, tier_1_completed, bulk_intake_mode, answers_recorded, skips }`.

### 2. `PlanningWorkflow` (binding `PLANNING_WORKFLOW` / class `PlanningWorkflow` / name `spence-planning`)

`Promise.all` parallel data gather — `inspire_read_seasonality`, `inspire_read_weather`, `inspire_read_calendar`, `inspire_read_household_signals` — each in its own `step.do` (independent retry). Then `step.do("propose_dishes")` calls `callMeshClaude` with a strict-JSON system prompt. Per dish: `step.waitForEvent<DishDecisionEvent>("approve_<id>", { type: "dish_decision", timeout: "1 hour" })`. Mandatory persistence: `step.do("create_plan")` + `step.do("compose_<date>_<slot>")` per approved dish. Then `step.do("audit")` (`plan_audit { run_critics: "all" }`) and `step.do("finalize")` (`plan_finalize` — PlanAgent.routeFinalize fiber spawns the MealAgents).

### 3. `CookSessionDebriefWorkflow` (binding `COOK_DEBRIEF_WORKFLOW` / class `CookSessionDebriefWorkflow` / name `spence-cook-debrief`)

`step.sleep("wait_for_post_meal", "30 minutes")` → `step.waitForEvent<MealRatingEvent>("rating", { type: "meal_rating", timeout: "24 hours" })`. Persists via `recordMealFeedback` (writes `mise_meal_feedback`). Folds high (≥4) and low (≤2) ratings into `comfort_vs_adventure` via `household_observe_response { observation_kind: "meal_loved" | "meal_rejected" }`. Auto-spawned by `MealAgent.applyPhaseStateHooks` on `phase === "eaten"` (additive — Phase 4 fibers preserved); duplicate-id errors are swallowed for fiber-recovery idempotency.

## Wrangler bindings

`worker/wrangler.mise.toml` now has 3 `[[workflows]]` blocks. No migration tag bump (workflows are not durable_objects).

## Trigger / status routes (`worker/src/mise-graph-worker.ts`)

- `POST /agent/workflow/:name/:id/start` → `env[NAME].create({ id, params })`
- `POST /agent/workflow/:name/:id/events` → `env[NAME].get(id).sendEvent({ type, payload })`
- `GET  /agent/workflow/:name/:id/status` → `env[NAME].get(id).status()`

`name` ∈ `{onboarding, planning, cook_debrief}`. Returns 503 when binding missing.

## Tests

- `u118` (22 assertions) — OnboardingWorkflow shape + step-do naming + bulk-intake gate.
- `u119` (22 assertions) — PlanningWorkflow shape + parallel gather + dish approval + persistence + audit + finalize.
- `u120` (23 assertions) — CookSessionDebriefWorkflow shape + MealAgent eaten hook + Phase 4 fibers preserved.

**Worker tests: 141 passed / 0 failed** (was 138 pre-Phase 2). `npx tsc --noEmit` clean. `wrangler --dry-run` shows all 3 Workflow bindings.

## Live verification

```
WORKER=https://mise-graph.9f745064e644311ed09914b9a12e9c7380ce62b7.workers.dev
curl -X POST $WORKER/agent/workflow/onboarding/test_hh/start \
  -d '{"params":{"household_id":"test_hh","answer_timeout":"1 hour"}}'
# → {"ok":true,"id":"test_hh","status":{"status":"queued"}}
curl $WORKER/agent/workflow/onboarding/test_hh/status
# → {"ok":true,"id":"test_hh","status":{"status":"running"}}
curl -X POST $WORKER/agent/workflow/onboarding/test_hh/events \
  -d '{"type":"onboarding_answer","payload":{"question_kind":"tier_0_household_name","response_text":"The Test Household"}}'
# → {"ok":true,"id":"test_hh","sent":"onboarding_answer"}
```

Workflow advanced past the first `waitForEvent`, status remained `running`, awaiting next question.

## Chat-surface integration (next)

Phase 3 (intent router) decides when chef routes a turn into `OnboardingWorkflow` vs `PlanningWorkflow`. Web UI follow-up: `POST /api/workflows/:name/:id/events` thin proxy from spence-web to the worker; chat surface polls `/status` to render "Spence is thinking" vs "waiting on your answer". Per-dish approval cards already match the `dish_decision` payload shape.
