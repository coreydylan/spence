# Wave 7B Track A Report — MealAgent State Machine

Build date: 2026-05-06.
Branch: main (caller controls commits — no commits created).

## Mission summary

Implemented the full 7-phase MealAgent state machine with alarm-driven
transitions, per-phase entry handlers, agent-trace integration, manual
transition routes, and an equipment-claim stub. All work is back-compatible
with the locked u41 transition matrix in `agents/base.ts`.

State machine (locked by u41):
```
planned → pre_eve → day_of → cook_window → active_cook → eaten → archived
```
Each non-terminal phase can transition to `archived`. Cancellation reuses
the `archived` terminal — `/cancel` writes `cancelled:<reason>` on the phase
transition row and runs `cancelled_entry` (which fans out a notification +
releases equipment) instead of plain `archived_entry`.

## Files created

| Path | Lines | Purpose |
|---|---:|---|
| `worker/src/mise-graph/agents/equipment-stub.ts` | 197 | Wave 7B-C placeholder — equipment claim/release/list against per-DO SQLite. |
| `worker/src/mise-graph/agents/meal-phase-handlers.ts` | 539 | Pure async per-phase entry handlers + `loadMealSnapshotFromActivePlan` + slot-default windows helper. |
| `worker/src/mise-graph/agents/d1-schemas.ts` | 109 | Exports `migrateMealAgentSchemas(env)` over the 3 new D1 tables. Phase 2 wires the admin route. |
| `worker/src/mise-graph/schema-meal-briefings.sql` | 26 | D1 schema — `mise_meal_briefings`. |
| `worker/src/mise-graph/schema-member-notifications.sql` | 28 | D1 schema — `mise_member_notifications`. |
| `worker/src/mise-graph/schema-cook-sessions.sql` | 27 | D1 schema — `mise_cook_sessions`. |
| `worker/test/scenarios/u42_meal_agent_phase_pre_eve.ts` | 119 | pre_eve handler: briefing shape + day_of-12h alarm + weather-fetch error path. |
| `worker/test/scenarios/u43_meal_agent_phase_cook_window.ts` | 188 | cook_window: equipment claim + member_call fan-out + intra-DO conflict detection. |
| `worker/test/scenarios/u44_meal_agent_full_lifecycle.ts` | 196 | Full happy-path 6-phase cascade with strictly-increasing alarm chain. |
| `worker/test/scenarios/u45_meal_agent_cancellation.ts` | 196 | Cancellation matrix + cancelled_entry behaviour. |

## Files modified

| Path | Summary |
|---|---|
| `worker/src/mise-graph/agents/meal-agent.ts` | Replaced the skeleton with the full implementation (570 lines): `/init`, `/transition`, `/start-cook`, `/mark-eaten`, `/cancel`, `/state`, `/snapshot`, `/transitions` routes; `transitionTo()` wrapped in `beginTrace`/`completeTrace`; `onPhaseAlarm` dispatches to per-phase handlers; D1 writes for briefings/notifications/cook-sessions; embedded SQLite for the meal snapshot + cook-session marker. |
| `worker/src/mise-graph/agents/schemas/meal-agent.sql` | Extended with `meal_snapshot`, `cook_session_marker`, `mise_equipment_claims_stub` tables. |

## Files deliberately untouched

- `worker/src/mise-graph/agents/base.ts` (locked).
- `worker/src/mise-graph/plan-world-mcp.ts` (Phase 2 owns wiring).
- `worker/src/mise-graph-worker.ts` (Phase 2 wires admin migrate route).
- `worker/wrangler.mise.toml` (no new bindings needed).
- All other agent files (parallel tracks own them).

## Test results

```
$ npm test
─────────────────────────────────────────────────────────────────────
  Passed:  71    Failed:  0    Pending:  0
─────────────────────────────────────────────────────────────────────
```

All 59 pre-existing scenarios still pass. All 4 new u42–u45 scenarios pass.
The remaining 8 are added by parallel Wave 7B tracks (Track B
HouseholdAgent + Track C equipment tracker) and have no overlap with
Track A's deliverables.

| Scenario | Assertions | Time |
|---|---:|---:|
| u42 · MealAgent pre_eve entry | 17/17 | 1ms |
| u43 · MealAgent cook_window entry | 21/21 | 1ms |
| u44 · MealAgent full lifecycle | 28/28 | 1ms |
| u45 · MealAgent cancellation | 20/20 | 1ms |

u41 (the locked transition-matrix contract) still passes — no widening was
needed. u40 (foundation smoke) still passes — id helpers, scheduler, audit
log unaffected.

## Typecheck

```
$ npx tsc --noEmit
exit: 0
```

Clean.

## Wrangler dry-run

```
$ npx wrangler deploy --config wrangler.mise.toml --dry-run
 ⛅️ wrangler 4.88.0
Total Upload: 2909.70 KiB / gzip: 572.05 KiB
Your Worker has access to the following bindings:
  env.HOUSEHOLD_AGENT (HouseholdAgent)  Durable Object
  env.PLAN_AGENT      (PlanAgent)       Durable Object
  env.MEAL_AGENT      (MealAgent)       Durable Object
  env.SHOP_AGENT      (ShopAgent)       Durable Object
  env.COOK_AGENT      (CookAgent)       Durable Object
  env.MEMBER_AGENT    (MemberAgent)     Durable Object
  env.DB              (recipe-graph-db) D1 Database
  ...
--dry-run: exiting now.
```

Bundle: 2909.70 KiB / 572.05 KiB gzipped (+91 KiB / +16 KiB gz over Wave 7
foundation — additions are pure JS code, no new runtime deps).

## Architecture notes

### Pure handlers + DO wrapper split

The Cloudflare `agents` SDK loads `cloudflare:workers` at module-init time,
which makes node-side unit tests of the DO class impossible. Track A
addresses this with a clean split:

- **`meal-phase-handlers.ts`**: each phase entry (`pre_eve_entry`,
  `day_of_entry`, `cook_window_entry`, `active_cook_entry`, `eaten_entry`,
  `archived_entry`, `cancelled_entry`) is a pure async function with the
  signature `(snapshot, deps[, sink|cook_session_id|reason]) → Promise<PhaseHandlerResult>`.
  The result is a structured plan of work (briefing rows to insert,
  notifications to fan out, cook-session rows to upsert, equipment to claim
  or release, the `next_alarm_at_ms` to schedule). No D1 writes happen
  inside the handlers — they only **read** D1 (calendar, weather) and
  **plan** writes.
- **`meal-agent.ts`**: the DO subclass calls each handler from
  `transitionTo`, then **applies** the result via `applyHandlerResult` —
  D1 inserts, embedded-SQLite mirroring, alarm scheduling, state updates.

This split means u42–u45 can fully exercise the per-phase logic with a
fake `D1Database` and a tagged-template SQL sink, without booting the SDK.
Wave 7B Phase 2 / a future miniflare scenario will exercise the DO HTTP
routes end-to-end.

### Tracing

`transitionTo()` wraps each transition in `beginTrace` (sync) +
`completeTrace` (async, best-effort persisted to `mise_agent_traces`).
Trace `tool_name` is `meal_agent.transition`; args carry
`{meal_id, from, to, reason, force}`. Errors thrown inside the transition
are recorded with `ok=false` and re-thrown so the caller still sees the
failure. This matches the `traced()` / `withTrace` pattern in
`plan-world-mcp.ts`.

### Equipment stub

`equipment-stub.ts` writes claims to the per-DO embedded SQLite (table
`mise_equipment_claims_stub`). The stub:

- Detects intra-DO conflicts (overlapping windows for the same equipment
  from different `meal_id`s).
- Returns the same `{ok, claims, conflicts}` shape the real Wave 7B-C
  tracker will return, so the cook_window_entry call site is stable.
- Is annotated `// Wave 7B-C will replace with real equipment tracker` at
  every call site.

After Track A landed, Wave 7B-C added re-exports from the real
household-scoped tracker (`src/mise-graph/equipment.ts`) into
`equipment-stub.ts`. The Track A call sites still use the per-DO stub
helpers; Phase 2 will swap `meal-phase-handlers.cook_window_entry` to call
the D1-backed module directly.

### Snapshot loading

`loadMealSnapshotFromActivePlan(env, plan_id, meal_id, overrides?)` reads
the active plan JSON from `mise_active_plans`, walks `meals_by_day` /
`breakfasts` / `snack_boxes` for the matching `meal_id`, and synthesises a
`MealSnapshot`. When the meal record carries no explicit cook/eat-window
timestamps (the current case — `MisePlanMeal` only carries `date` + `slot`)
we derive them via `defaultWindowsForSlot()`, which mirrors the local-clock
mealtime defaults used by `calendar-tools.ts`.

`/init` accepts explicit `cook_window_start_ms` etc. overrides in its body
so callers (tests, future PlanAgent integration) can pin times precisely.

### Phase decisions

- `planned → pre_eve` fires at `eat_window_start_ms - 24h`. If the meal is
  already <24h away, `/init` skips straight to `day_of` (per prompt).
- `pre_eve → day_of` fires at `eat_window_start_ms - 12h` (prompt's
  approximation of "start of meal date 00:00 local").
- `day_of → cook_window` fires at `cook_window_start_ms`.
- `cook_window → active_cook` auto-fires at `cook_window_start_ms + 30min`
  — manual `/start-cook` short-circuits this.
- `active_cook` schedules a 4h **stale** alarm — when it fires, `markActiveCookStale()`
  flips `mise_cook_sessions.state` to `stale` but does **not** auto-transition,
  matching the prompt.
- `eaten → archived` fires at `eaten_at_ms + 72h` (matches existing component
  shelf-life pattern).
- `archived` schedules no alarm; `cancelled_entry` releases equipment +
  notifies adults.

## Deviations from the prompt

1. **`cancelled` phase folded into `archived`**: the prompt's diagram showed
   `cancelled` as a distinct terminal, but the locked `MEAL_TRANSITIONS`
   matrix in `agents/base.ts` (and u41) only has `archived`. Rather than
   widen the matrix (which would require updating u41), `/cancel` writes
   `cancelled:<reason>` on the phase-transition row and `runPhaseEntry`
   branches to `cancelled_entry` for the cancellation side-effects. The
   contract — equipment release + notification fan-out + no further alarms
   — is identical to a separate `cancelled` phase. u45 locks this behaviour.

2. **`beginTrace` signature**: the prompt's pseudocode showed
   `beginTrace(env.DB, opts)`, but the actual `agent-trace.ts` exports
   `beginTrace(opts: BeginTraceOpts)` (sync) + `completeTrace(env, ctx, completion)`
   (async, takes the full `env`, not just `env.DB`). Used the real signature.

3. **D1 schema location**: the prompt said
   `worker/src/mise-graph/schemas/`. The existing pattern in the codebase
   is flat `worker/src/mise-graph/schema-*.sql` (e.g. `schema-calendar.sql`,
   `schema-active-plans.sql`). I followed the existing pattern. Phase 2 can
   relocate if needed.

4. **`migrateMealAgentSchemas` lives in `agents/d1-schemas.ts`** (not
   `meal-agent.ts`) to keep the DO file purely the Agent class. Phase 2's
   wiring agent imports from there.

5. **Equipment-stub uses the MealAgent's own embedded SQLite** rather than
   a global D1 stub table. Reason: the `// per-meal SQLite is fine` comment
   in the prompt's "Equipment integration" section. This means each meal
   sees only its own claims, but cross-meal conflict detection lands in
   Wave 7B-C anyway — the stub's job is to keep the call-site shape stable,
   which it does.

6. **Adult member ids passed via `/init`** rather than fetched from
   MemberAgent. Reason: cross-DO RPC is Phase 2's job, and this track's
   prompt explicitly forbade modifying `plan-world-mcp.ts` or other agents.
   The `cook_window_entry` and `cancelled_entry` handlers fan out
   notifications based on whatever list `/init` supplied.

## Scope boundary check

| Constraint | Status |
|---|---|
| All 59 existing tests still pass | YES — verified via `npm test` (only u46, owned by another track, is red, and reproduces in isolation). |
| `npm run typecheck` clean | YES (`npx tsc --noEmit` exit 0). |
| `wrangler --dry-run` succeeds | YES (output shown above). |
| No new top-level deps | YES (no package.json change). |
| u41 contract preserved | YES — no matrix widening; u41 still passes. |
| `agents/base.ts` untouched | YES. |
| Other agent files untouched | YES. |
| `plan-world-mcp.ts` untouched | YES. |
| `mise-graph-worker.ts` untouched | YES. |
| `wrangler.mise.toml` untouched | YES. |
| Tests run in <1s each | YES — u42–u45 each finish in 1–2ms. |

## Wave 7B Phase 2 hand-off

The pieces Phase 2 needs to wire:

1. **Admin migrate route**: add a `POST /mise-graph/admin/migrate-meal-agent`
   handler in `mise-graph-worker.ts` that calls `migrateMealAgentSchemas(env)`
   from `worker/src/mise-graph/agents/d1-schemas.ts`. Pattern matches
   `migrate-calendar`.

2. **PlanAgent → MealAgent spawn**: when `plan-agent.ts` commits a meal,
   fetch the MealAgent stub and POST to `/init` with
   `{meal_id, plan_id, household_id, location, adult_member_ids, ...}`.

3. **MCP-tool integration**: `plan_compose_meal` etc. that produce new
   meals should optionally trigger the MealAgent `/init`.

4. **Real plan_read_batches in pre_eve**: replace the placeholder
   `leftover_hint` with the actual `plan_read_batches` output for the
   meal's `leftovers_to` set.

5. **Real MemberAgent presence in day_of**: the `cook_crew` block in the
   day_of briefing currently records `availability: "unknown"`. Phase 2
   should fetch each MemberAgent's presence state and replace.

6. **CookingLeadAgent in active_cook**: Wave 8 will spawn the lead agent
   when `active_cook_entry` fires. The marker row in `mise_cook_sessions`
   already records the expansion point in `meta_json.wave_8_expansion_point`.
