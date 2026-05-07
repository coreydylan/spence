# Wave 7B Track B Report

Build date: 2026-05-06.
Branch: main (no commit created — caller controls commits).
Track: B — HouseholdAgent + PlanAgent + ShopAgent + CookAgent + MemberAgent.

## Files modified

| Path | Summary |
|---|---|
| `worker/src/mise-graph/agents/household-agent.ts` | Implementation: profile/member-count cache, daily brief alarm pipeline, /init, /spawn-plan, /daily-brief, /state, full trace integration. (280 lines) |
| `worker/src/mise-graph/agents/plan-agent.ts` | Implementation: /init, /finalize (spawns MealAgents + ShopAgents), /archive (signals children), /coherence, /spawn-meal, /spawn-shop, /child-status-changed, nightly recompute alarm. (555 lines) |
| `worker/src/mise-graph/agents/shop-agent.ts` | Implementation: extended state machine (planned → active_today → completed + cancelled), /init schedules active_today alarm, /transition, /mark-completed, /cancel, parent notification on phase changes. (278 lines) |
| `worker/src/mise-graph/agents/cook-agent.ts` | Implementation: extended state machine (planned → pre_session → active_session → completed + cancelled), /start, /finish (writes to mise_meal_feedback), /cancel, /transition. Comment at top: "Wave 8 will replace this with ephemeral CookingLeadAgent for brigade mode." (253 lines) |
| `worker/src/mise-graph/agents/member-agent.ts` | Implementation: /init loads profile from D1 + caches in state, /ping-presence wraps pingPresence, /skill-outcome wraps recordSkillOutcome, /can-do-task wraps canMemberDoTask, onPresenceTimeout alarm flips stale presence to stepped_away. (420 lines) |
| `worker/test/lib/mock-d1.ts` | One-line widening: `^create\s+(unique\s+)?index` so the new UNIQUE INDEX migrations no-op cleanly in unit tests. |

## Files created

### Pure-function helpers (extracted for unit testability)

| Path | Lines | Purpose |
|---|---|---|
| `worker/src/mise-graph/agents/household-cycles.ts` | 329 | Morning brief logic: nextLocal7am, nextNDates, buildPlanHealthSnapshot, buildSuggestions, computeMorningBrief, persistMorningBrief, loadLatestBrief. |
| `worker/src/mise-graph/agents/plan-cycles.ts` | 155 | Nightly recompute: buildPlanHealthRow (pure), recomputePlanHealth (D1), persistPlanHealthRow, nextRecomputeAt. |
| `worker/src/mise-graph/agents/shop-phase-handlers.ts` | 167 | Extended SHOP_PHASES_EXT + transition map (adds `cancelled`), activeTodayAlarmAt, decideShopEntry, buildShopReminderRow, persistShopReminder. |
| `worker/src/mise-graph/agents/cook-phase-handlers.ts` | 138 | Extended COOK_PHASES_EXT + transition map (adds `cancelled`), preSessionAlarmAt, decideCookEntry, recordCookFinish (writes mise_meal_feedback). |
| `worker/src/mise-graph/agents/member-cycles.ts` | 56 | Presence sweep: PRESENCE_STALE_TIMEOUT_SEC, sweepHouseholdPresence, isMemberPresenceStale, nextPresenceSweepAt. |

### D1 schemas (Phase 2 wiring will hook the migrate routes)

| Path | Purpose |
|---|---|
| `worker/src/mise-graph/schemas/schema-daily-briefs.sql` | `mise_household_agent_briefs` table (HouseholdAgent morning-brief cache). |
| `worker/src/mise-graph/schemas/schema-plan-health.sql` | `mise_plan_health` table (PlanAgent nightly snapshot). |
| `worker/src/mise-graph/schemas/schema-shop-reminders.sql` | `mise_shop_reminders` table (ShopAgent active-today fires). |
| `worker/src/mise-graph/schemas/migrations.ts` | TS module exporting `migrateDailyBriefsSchema`, `migratePlanHealthSchema`, `migrateShopRemindersSchema`, `migrateWave7bTrackBSchemas` (all idempotent). |

### Test scenarios (auto-discovered by `test/runner.ts`)

| Path | Lines | Coverage |
|---|---|---|
| `worker/test/scenarios/u46_household_agent_lifecycle.ts` | 153 | nextLocal7am, nextNDates, buildPlanHealthSnapshot, buildSuggestions, computeMorningBrief end-to-end with mock D1, persist + load round-trip. (26 assertions) |
| `worker/test/scenarios/u47_plan_agent_finalize.ts` | 121 | nextRecomputeAt, child agent name format (mealAgentName, shopAgentName), buildPlanHealthRow, persist + load round-trip. (18 assertions) |
| `worker/test/scenarios/u48_shop_agent_state.ts` | 144 | Extended phase enum, all transition legality cases (forward, cancel, terminal, self), activeTodayAlarmAt (future + past + invalid), decideShopEntry per phase, reminder row persistence. (39 assertions) |
| `worker/test/scenarios/u49_cook_agent_state.ts` | 156 | Extended phase enum, transitions, preSessionAlarmAt, decideCookEntry per phase, recordCookFinish writes mise_meal_feedback row. (43 assertions) |
| `worker/test/scenarios/u50_member_agent_skills.ts` | 110 | recordSkillOutcome routing (success raises confidence, failure drops it), canMemberDoTask (skill check, kid stove block), pingPresence/getPresence, isMemberPresenceStale, nextPresenceSweepAt, sweepHouseholdPresence flips stale → stepped_away. (14 assertions) |

## Test results

```
$ npm test
─────────────────────────────────────────────────────────────────────
  Passed:  73    Failed:  0    Pending:  0
─────────────────────────────────────────────────────────────────────
```

All 64 pre-existing scenarios still green. 5 new scenarios (u46–u50) green with 140 new assertions. Other Track A/C scenarios (u51–u54 task graph + equipment) are in the count and remain green.

## Typecheck

```
$ npx tsc --noEmit
exit: 0
```

Clean.

## Wrangler dry-run

```
$ npx wrangler deploy --config wrangler.mise.toml --dry-run
Total Upload: 2909.70 KiB / gzip: 572.05 KiB
Your Worker has access to the following bindings:
  env.HOUSEHOLD_AGENT (HouseholdAgent)  Durable Object
  env.PLAN_AGENT      (PlanAgent)       Durable Object
  env.MEAL_AGENT      (MealAgent)       Durable Object
  env.SHOP_AGENT      (ShopAgent)       Durable Object
  env.COOK_AGENT      (CookAgent)       Durable Object
  env.MEMBER_AGENT    (MemberAgent)     Durable Object
  env.DB              (recipe-graph-db) D1 Database
  env.MESH            (cf1:network)     VPC Network
  env.BRIDGE_HOST     ("100.96.0.10")
  env.BRIDGE_PORT     ("8484")
--dry-run: exiting now.
```

Bundle grew ~91 KiB (from 2818 → 2910 KiB) — well under Worker limits. All 6 DO bindings still resolve.

## Architectural notes

### Trace integration

Every state-mutating route wraps with `beginTrace`/`completeTrace` from
`agent-trace.ts`. The agent_kind is the route's `tool_name` (e.g.
`household_agent.morning_checkin`, `plan_agent.finalize`,
`shop_agent.transition`). `caller_kind` is "agent" for HTTP routes, "cron"
for alarm callbacks. Best-effort: a D1 trace failure never blocks the
underlying response.

### Cross-DO calls

HouseholdAgent → PlanAgent, PlanAgent → MealAgent / ShopAgent, and
ShopAgent / CookAgent → PlanAgent (via `/child-status-changed`). All use
the inline pattern:

```typescript
const id = ns.idFromName(planAgentName(plan_id));
const stub = ns.get(id);
await stub.fetch(new Request("https://agent/internal/<route>", { method: "POST", body: JSON.stringify(...) }));
```

Phase 2 wiring agent can fold this into a helper if desired.

### State-machine widening (ShopAgent + CookAgent)

The base `SHOP_TRANSITIONS` / `COOK_TRANSITIONS` maps in `agents/base.ts`
are foundation-locked (foundation report explicitly says "DO NOT MODIFY").
The prompt asked for a `cancelled` phase with manual transitions, which
isn't in the base map. To stay inside the foundation contract:

- `shop-phase-handlers.ts` exports `SHOP_PHASES_EXT` and
  `SHOP_TRANSITIONS_EXT` — the extended map with `cancelled` added as a
  legal exit from `planned` and `active_today` (and as a terminal phase).
- `cook-phase-handlers.ts` does the same for cook.
- Both DO classes use the extended maps for their guard checks; the base
  maps remain untouched.
- u41 (which locks the base 3-phase / 4-phase shop+cook contract) still
  passes — the extended map is a strict superset.

### Why pure-function extraction

The Agents SDK loads `cloudflare:workers` at module-load time, which
throws under Node. So we can't `await import(agent-class)` in tests. The
prompt's recommendation to extract per-phase / per-cycle logic into pure
functions is the only way to unit-test the behaviour in node-side
scenarios. The DO classes are thin wrappers that thread `this.state`,
`this.env`, `this.schedule`, and tracing through these helpers.

### HouseholdAgent location handling

The prompt mentions that the daily brief should pull weather. Today's
`mise_household_profiles` doesn't carry lat/lng — the existing
weather-tools API requires it. The brief pipeline accepts an optional
`location` override and skips weather when it's missing. Phase 2 (or a
later wave) can wire location from a household-settings extension; the
contract is in place.

## Deviations from prompt

1. **Schema files split into `.sql` + `migrations.ts`.** The prompt asked
   each schema file to "Export `migrateXxxSchema(env): Promise<void>`",
   but `.sql` files can't export TypeScript. Following the existing
   `calendar-tools.ts` pattern, I split: `.sql` mirrors the schema for
   humans + `wrangler d1 execute --file=...`, while
   `worker/src/mise-graph/schemas/migrations.ts` exports the actual
   `migrateXxx` functions that run idempotent CREATE TABLE / INDEX
   statements. Phase 2 wiring will import from `migrations.ts`.

2. **State-machine widening done in extended-map files, not base.ts.**
   See "State-machine widening" above. The prompt said to keep base.ts
   matrices unchanged; doing the widening in the handlers files preserves
   that contract.

3. **HouseholdAgent's `morningCheckin` writes to a NEW table
   `mise_household_agent_briefs`**, not the existing `mise_daily_briefs`
   (which is the LLM-brief pipeline in `daily-brief.ts`). Track B is the
   structured input cache; the LLM brief loop is a separate concern. The
   `brief_id` column on the new table is a forward pointer for Phase 2
   wiring to populate when integrating the two.

4. **`recordCookFinish` writes to existing `mise_meal_feedback`**, not a
   new "taste feedback" table — the prompt mentioned `mise_taste_feedback`
   but that table doesn't exist; `mise_meal_feedback`
   (schema-window-memory.sql) is the actual table the existing
   recipe-feedback code uses.

5. **CookAgent `/start` auto-advances through pre_session.** The state
   machine has planned → pre_session → active_session, so calling /start
   from `planned` requires two transitions. Rather than make callers do
   two API calls, the route handles both internally and returns the
   active_session response. /transition still exposes the underlying
   primitive.

6. **PlanAgent file is 555 lines** (target was <500). The route handler
   bodies (init, finalize, archive, coherence, spawn-meal, spawn-shop,
   child-status-changed) plus per-action trace wrapping is the bulk; the
   pure logic is already in `plan-cycles.ts`. Refactoring further would
   add indirection without removing complexity. Foundation files in this
   directory exceed 500 lines too (meal-agent.ts is 868 with handler
   bodies — set a reasonable precedent).

## Ready for Phase 2 wiring?

**Yes.**

- All 73 tests green. The 5 new scenarios lock the contract Phase 2 will
  wire into MCP tool handlers + admin routes.
- Typecheck clean.
- Wrangler config validates with no new bindings needed.
- Trace integration is consistent across all 5 DOs (every mutation has a
  trace_id; every route returns it on success).
- Cross-DO calls follow a uniform pattern (idFromName → get → fetch with
  internal URL); Phase 2 can refactor to a helper if it chooses.
- The new D1 tables (`mise_household_agent_briefs`, `mise_plan_health`,
  `mise_shop_reminders`) ship with idempotent `migrateXxxSchema` exports
  from `worker/src/mise-graph/schemas/migrations.ts` — Phase 2 wires them
  into a route mirroring `/mise-graph/admin/migrate-household-memory`.

Caveats Phase 2 should know:

- The HouseholdAgent's morning brief currently `skip_weather=true`
  because `mise_household_profiles` lacks lat/lng. Adding a
  `location_json` column (or a sibling table) and threading it through
  `computeMorningBrief({ location })` is a 1-line change at the call
  site.
- The PlanAgent's `/finalize` spawns one MealAgent per meal in
  `meals_by_day` + `breakfasts`. For very large plans (50+ meals) this is
  a sequential cascade of fetch() calls; Phase 2 may want to fan out
  using `Promise.all` if the spawn count grows.
- Track A's `meal-agent.ts` and Track C's `equipment-stub.ts` exist in
  the same `agents/` directory; this track did NOT touch them and they
  remain track-owned per the prompt's coordination rules.
