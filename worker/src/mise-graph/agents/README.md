# Spence entity agents (Wave 7 foundation)

This directory holds the six Durable Object classes that own household entity
state. Built on top of Cloudflare's `agents` SDK (v0.12.x). Each class extends
`Agent<Env, State>`; the SDK provides per-DO embedded SQLite (`this.sql`),
auto-persisted typed state (`setState`), and a scheduler (`this.schedule`,
`this.scheduleEvery`).

Wave 7 ships the **skeletons** only. The state-machine behaviour (entry/exit
hooks, alarm rules, side-effects) is staged for Wave 7B.

## DO id format

Every DO is named via `idFromName(...)`. Names are computed by the helpers in
`./base.ts` — never hand-roll one.

| Agent           | DO name format                              | Helper                       |
|-----------------|---------------------------------------------|------------------------------|
| HouseholdAgent  | `household:${household_id}`                 | `householdAgentName`         |
| PlanAgent       | `plan:${plan_id}`                           | `planAgentName`              |
| MealAgent       | `meal:${plan_id}:${date}:${slot}`           | `mealAgentName`              |
| ShopAgent       | `shop:${plan_id}:${shop_run_id}`            | `shopAgentName`              |
| CookAgent       | `cook:${meal_id}:${session_id}`             | `cookAgentName`              |
| MemberAgent     | `member:${household_id}:${member_id}`       | `memberAgentName`            |

The MealAgent name is intentionally identical to the existing meal_id used by
plan-world tracing, so a trace_id can be resolved back to a meal DO via the
existing `mise_mutation_traces` table.

## State shape

State lives on `this.state` (typed, auto-persisted, broadcast to connected
WebSockets via the SDK's protocol layer). Mutate with `setState(next)` — never
assign to `this.state` directly.

| Agent           | Phases                                                                    |
|-----------------|---------------------------------------------------------------------------|
| HouseholdAgent  | n/a (long-lived; no state machine)                                        |
| PlanAgent       | `draft → active → final → archived` (status field, not strict transitions)|
| MealAgent       | `planned → pre_eve → day_of → cook_window → active_cook → eaten → archived` |
| ShopAgent       | `planned → active_today → completed`                                      |
| CookAgent       | `planned → pre_session → active_session → completed`                      |
| MemberAgent     | n/a (long-lived; presence is a separate enum)                             |

The legal-transitions matrix for each phase-bearing agent lives in `./base.ts`
as `MEAL_TRANSITIONS`, `SHOP_TRANSITIONS`, `COOK_TRANSITIONS`. Use
`isLegalTransition(map, from, to)` from a `transitionTo()` body — every guard
must go through that helper so the test in `u41_meal_agent_state_skeleton.ts`
keeps the contract honest.

## Where Wave 7B implementation goes

Each agent file has a single `transitionTo()` (where applicable) and one or
more named alarm callbacks (e.g. `dailyCheckin`, `onPhaseAlarm`). Wave 7B:

1. **Entry hooks** — fill in the per-phase side effects in `transitionTo()`
   directly (briefing on `pre_eve`, claim equipment on `cook_window`, etc.).
2. **Alarm rules** — replace the foundation `null`-returning stubs with real
   `(state) → Date | null` functions. Use the `scheduleNextAlarm` helper from
   `./base.ts` to pin the SDK's `schedule(at, callback, payload)` call.
3. **MCP routing** — Wave 7B's job, not Wave 7's. The existing 79 MCP tool
   handlers in `../plan-world-mcp.ts` remain untouched in Wave 7. When 7B
   migrates them, they read state from these DOs via `getAgentByName(...)`
   (or the `idFromName + .get` pattern) instead of D1 directly.
4. **Schemas** — extend the per-agent SQLite by adding `CREATE TABLE IF NOT
   EXISTS` calls inside the relevant `onStart()`. The `schemas/*.sql` files
   in `./schemas/` are the canonical reference; keep them in sync.

## Smoke tests

- `test/scenarios/u40_agent_lifecycle_smoke.ts` — exercises the lifecycle
  helpers and id naming (in-process; pure unit).
- `test/scenarios/u41_meal_agent_state_skeleton.ts` — locks the MealAgent
  phase enum + transition matrix.

The DOs themselves aren't exercised in-process — that requires `wrangler dev`
or Cloudflare's vitest pool. The lifecycle smoke tests verify the static
contract; full DO runtime tests come in Wave 7B with miniflare wiring.
