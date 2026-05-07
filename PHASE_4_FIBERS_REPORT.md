# Phase 4 — Cloudflare Agents SDK Fibers

## SDK version path

**Used the built-in API.** `agents@0.12.3` already exposes
`Agent.runFiber(name, fn)`, `ctx.stash(data)`, `Agent.onFiberRecovered`,
`keepAlive()`, and the `FiberContext` / `FiberRecoveryContext` types
(all confirmed in `node_modules/agents/dist/agent-tool-types-DSteYkkS.d.ts`
and re-exported from `index.d.ts`). No package bump or polyfill required.

## Fibers wrapped

| # | DO | Fiber name | Stash schedule |
|---|----|-----------|----------------|
| 1 | `HouseholdAgent.morningCheckin` | `morning_brief` | `{ brief }` after `computeMorningBrief` → `{ brief, persisted_id }` after `persistMorningBrief` |
| 2 | `MealAgent.transitionTo` | `transition_to_<phase>` (one per target phase) | `{ from, to, reason, now }` at start → `{ ...+result }` after handler → `{ ...+applied:true }` after side-effects + alarm |
| 3 | `CookingLeadAgent.onSchedulerTick` | `scheduler_tick` | `{ now, input }` → `{ ...+output }` → `{ ...+applied:true }` |
| 4 | `PlanAgent.routeFinalize` | `finalize_spawn` | After plan load: `{ plan_loaded, totals, spawned_meals:[], spawned_shops:[] }`; pushed after each successful child spawn; `{ ...+finalized:true }` after status flip |

## onFiberRecovered handlers

Each DO exports an `async onFiberRecovered(ctx: FiberRecoveryContext)`
that branches on `ctx.name` and replays only the missing steps:

- **HouseholdAgent**: re-enters `runMorningBriefPipeline` with the
  recovered snapshot; skips compute if `brief` already stashed, skips
  persist if `persisted_id` already stashed.
- **MealAgent**: if `applied: true`, exits; if `result` stashed,
  re-applies side-effects + alarm; otherwise re-runs the handler from
  scratch. Audit row + state flip already committed before the fiber so
  re-entry is safe.
- **CookingLeadAgent**: replays `applySchedulerOutput` if `output` is
  stashed and not stale (≤ 2 ticks old); always re-arms the next tick.
- **PlanAgent**: re-enters `runFinalizeSpawnFiber` with the snapshot; the
  `spawned_meals`/`spawned_shops` sets ensure no duplicate spawns.

## Constraint compliance

- `worker/src/mise-graph/ledger.ts` — untouched.
- Phase handlers in `meal-phase-handlers.ts` — pure, untouched.
  `runPhaseEntry` was renamed `runPhaseEntryInner` and split from side-
  effect application (`applyHandlerResult` + new `applyPhaseStateHooks`
  + new `scheduleNextPhaseAlarm`) so the fiber wrapper can checkpoint
  between handler return and side-effects landing.
- `npx tsc --noEmit` clean.
- `npx wrangler deploy --dry-run --config wrangler.mise.toml` clean.

## Tests

- `worker/test/scenarios/u114_household_fiber_recovery.ts` — 26 assertions, locks fiber + recovery contract for HouseholdAgent, PlanAgent, CookingLeadAgent + verifies SDK API surface.
- `worker/test/scenarios/u115_meal_agent_fiber_per_transition.ts` — 25 assertions, locks per-transition fiber wrapping in MealAgent and confirms phase handlers stay pure.

**Worker test count: 135 passed / 0 failed / 1 live-tier skipped → 136 total.** (was 133 before Phase 4.)
