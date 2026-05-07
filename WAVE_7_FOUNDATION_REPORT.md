# Wave 7 Foundation Report

Build date: 2026-05-06.
Branch: main (no commit created — caller controls commits).

## Files created

| Path | Lines |
|---|---|
| `worker/src/mise-graph/agents/base.ts` | 283 |
| `worker/src/mise-graph/agents/household-agent.ts` | 169 |
| `worker/src/mise-graph/agents/plan-agent.ts` | 193 |
| `worker/src/mise-graph/agents/meal-agent.ts` | 155 |
| `worker/src/mise-graph/agents/shop-agent.ts` | 107 |
| `worker/src/mise-graph/agents/cook-agent.ts` | 109 |
| `worker/src/mise-graph/agents/member-agent.ts` | 128 |
| `worker/src/mise-graph/agents/README.md` | 78 |
| `worker/src/mise-graph/agents/schemas/household-agent.sql` | 34 |
| `worker/src/mise-graph/agents/schemas/plan-agent.sql` | 27 |
| `worker/src/mise-graph/agents/schemas/meal-agent.sql` | 21 |
| `worker/src/mise-graph/agents/schemas/shop-agent.sql` | 18 |
| `worker/src/mise-graph/agents/schemas/cook-agent.sql` | 23 |
| `worker/src/mise-graph/agents/schemas/member-agent.sql` | 47 |
| `worker/test/scenarios/u40_agent_lifecycle_smoke.ts` | 294 |
| `worker/test/scenarios/u41_meal_agent_state_skeleton.ts` | 189 |

Total new code: 1875 lines (a chunk of which is JSDoc + schemas).

## Files modified

| Path | Summary |
|---|---|
| `worker/wrangler.mise.toml` | Added 6 `[[durable_objects.bindings]]` (one per agent) and a `[[migrations]]` block with `tag = "v1"` and `new_sqlite_classes = [...]`. |
| `worker/src/mise-graph-worker.ts` | Re-exports the 6 DO classes (so the wrangler migration finds them); extends `Env` with the 6 DO namespaces; adds an admin-gated `POST /mise-graph/agents/spawn` debug route that initialises a HouseholdAgent and asks it to spawn a PlanAgent. |
| `worker/package.json` | Adds `agents@0.12.3` (Cloudflare's official package — `@cloudflare/agents` is deprecated in favour of `agents`). |
| `worker/tsconfig.json` | Added `"skipLibCheck": true`. The `agents` SDK transitively pulls in `@ai-sdk/*`, `ai`, `@modelcontextprotocol/sdk`, etc. whose `.d.ts` files reference `node:*`/DOM globals not in our `lib`. `skipLibCheck` is the standard mitigation and matches what Cloudflare's own templates ship with. |
| `worker/package-lock.json` | Updated by `npm install agents`. |

## Test results

```
$ npm test
─────────────────────────────────────────────────────────────────────
  Passed:  59    Failed:  0    Pending:  0
─────────────────────────────────────────────────────────────────────
```

All 57 pre-existing scenarios still green. New scenarios:

- `u40 · Wave 7 entity-DO foundation: id helpers, guards, scheduler, audit log` — 35 assertions, 3ms.
- `u41 · MealAgent skeleton: phase enum + transition matrix locks the state machine contract` — 57 assertions, 1ms.

Note on u40: the Agents SDK loads `cloudflare:workers` at module-load time, so we cannot `await import(...)` the entity DO files in the Node-side test runner. u40 instead does a static source check (regex on `export class X extends Agent`) for each of the 6 files plus the worker entry's re-exports. Wave 7B should add a miniflare-based integration scenario that actually boots the DO runtime — flagged in u40's notes.

## Typecheck

```
$ npx tsc --noEmit
exit: 0
```

Clean. No errors, no warnings.

## Wrangler dry-run

```
$ npx wrangler deploy --config wrangler.mise.toml --dry-run
 ⛅️ wrangler 4.88.0
Total Upload: 2818.54 KiB / gzip: 556.13 KiB
Your Worker has access to the following bindings:
  env.HOUSEHOLD_AGENT (HouseholdAgent)  Durable Object
  env.PLAN_AGENT      (PlanAgent)       Durable Object
  env.MEAL_AGENT      (MealAgent)       Durable Object
  env.SHOP_AGENT      (ShopAgent)       Durable Object
  env.COOK_AGENT      (CookAgent)       Durable Object
  env.MEMBER_AGENT    (MemberAgent)     Durable Object
  env.DB              (recipe-graph-db) D1 Database
  env.MESH            (cf1:network)     VPC Network
  env.BRIDGE_HOST     ("100.96.0.10")   Environment Variable
  env.BRIDGE_PORT     ("8484")          Environment Variable
--dry-run: exiting now.
```

All 6 DO bindings resolve to their classes. v1 SQLite migration is recognised. No deploy executed.

## Deviations from prompt

1. **SDK package name**: The prompt suggested `@cloudflare/agents`. That package is deprecated (last published as 0.0.16). The current canonical package is `agents@0.12.3`. The class API is functionally identical (`Agent<Env, State>`, `this.sql`, `this.schedule`, `onStart`, `onRequest`, `alarm`). All Wave 7 code imports from `agents`.
2. **`onRequest` vs `fetch`**: The Agent class has both — `fetch(req)` is overridden by the SDK to do sub-agent forwarding, while `onRequest(req)` is the user-facing hook inherited from `partyserver.Server`. Each agent class implements `onRequest`, which is what the SDK docs steer users toward.
3. **`AgentNamespace` type**: The SDK marks `AgentNamespace<T>` as deprecated in favour of plain `DurableObjectNamespace`. I used `DurableObjectNamespace` in the worker's `Env` interface to keep the legacy MCP code path independent of the agents-SDK types.
4. **Module augmentation in `base.ts`**: The Agents SDK's `Agent<Env, State>` constrains `Env extends Cloudflare.Env`. I used a `declare global { namespace Cloudflare { interface Env extends MiseGraphEnv { ... } } }` block in `agents/base.ts` so DO subclasses can be parameterised with the project env without re-declaring it everywhere. The exported `AgentEnv` alias is what the agent classes use.
5. **u40 scope**: As noted, in-process import of the agent classes throws because `agents` requires `cloudflare:workers`. u40 uses static source inspection instead. The mock-DO-namespace approach the prompt suggested would mean re-implementing significant SDK internals; the static check is the cleaner path and the contract it locks (file exists, exports the class extending Agent) is what Wave 7B actually needs.
6. **`scheduleNextAlarm` sig**: The prompt suggested `transitionRules[newPhase].nextAlarmFn(state)`. I implemented this as a standalone helper (`scheduleNextAlarm(agent, state, ruleFn, callbackName, payload)`) rather than a registry. Wave 7B can still build a `transitionRules` map and call this helper with the relevant rule function; keeping it standalone avoids inventing a registry shape in foundation that the implementation wave might want to refactor anyway.
7. **`tsconfig.json` `skipLibCheck`**: Necessary for the `agents` SDK to coexist with our worker-only `lib`/`types`. Documented in the modified-files table.

## Wave 7B TODO map (per agent)

Each agent file has explicit `// Wave 7B TODO:` comments where the next implementation step lands. Summary:

- **`household-agent.ts`** — `onStart` should load profile + members from D1; `dailyCheckin` should pull weather + calendar + plan health and write to `mise_daily_briefs`; the `spawn-plan` route should pass through a real plan-creation flow (currently just records the spawn).
- **`plan-agent.ts`** — `action: create|finalize|archive` cases need to call into the existing `plan-world-tools.ts` functions (currently just toggle status). `spawn-meal`/`spawn-shop` need to actually call the child DOs' `/init` routes (currently just record the child name).
- **`meal-agent.ts`** — `transitionTo` should look up `transitionRules[to].nextAlarmFn(state)` and pin the alarm; `onPhaseAlarm` should dispatch to per-phase entry handlers. The 7 phase-handler bodies (briefing on `pre_eve`, equipment claim on `cook_window`, etc.) are the bulk of Wave 7B's work.
- **`shop-agent.ts`** — same shape as MealAgent: phase-handler bodies + `nextAlarmFn` map.
- **`cook-agent.ts`** — same shape as MealAgent. Also: Wave 8 makes this DO ephemeral and adds `CookingLeadAgent`; foundation kept it long-lived for Wave 7B's smoke-test ergonomics.
- **`member-agent.ts`** — `onStart` should load profile from `household-members.ts` D1 helpers and cache in state; `/skill-outcome` route should mirror `recordSkillOutcome` and flush via `pending_skill_outcomes` buffer.

## Ready for Wave 7B?

**Yes.**

Reasons:
- All 79 existing MCP tools keep working (57 baseline scenarios green).
- Typecheck clean.
- Wrangler config validates and resolves all 6 DO bindings to classes.
- The shared conventions (`agents/base.ts`) are locked: id format, phase enums, transition matrices, alarm helper, audit-log helpers, generateAgentId.
- The state-machine contract is test-locked (u41) so any Wave 7B widening of the matrix forces a deliberate update.
- Each agent file has a clear single point where Wave 7B implementation lands (the `transitionTo` body, the `onPhaseAlarm` callback, the route handlers in `onRequest`).

Caveats Wave 7B should know:
- The `agents` package adds ~280 transitive deps (this is normal for the SDK; it ships `ai`, `@ai-sdk/*`, `partyserver`, etc.). Bundle size grew to 2.8 MiB / 556 KiB gzipped — well under the 10 MiB Worker limit but worth tracking.
- Cloudflare's vitest-pool-workers or miniflare-based test setup is the natural next step for Wave 7B to actually exercise DO runtime behaviour in tests. Foundation deliberately left this as a follow-up rather than wiring a half-working version.
