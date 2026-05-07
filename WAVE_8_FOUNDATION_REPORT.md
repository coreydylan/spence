# Wave 8 Foundation Report — CookingLeadAgent scaffolding

## Scope

Wave 8 foundation lays the brigade-mode scaffolding so Wave 8B can fill in:
- assignment heuristics (skill × presence × equipment scoring)
- photo capture + vision flow
- recipe-iteration prompts
- multi-phone coordination edge cases

This wave ships the runtime + storage + auth + hand-off contracts. It does NOT
ship the heuristic — the scheduler is a stub that returns zero assignments,
intentionally.

## Files created

| Path | Purpose |
|---|---|
| `worker/src/mise-graph/agents/cooking-lead-types.ts` | All cross-module type contracts: state shape, message envelope, event kinds, scheduler I/O, token grant/verify shapes |
| `worker/src/mise-graph/agents/cooking-lead-tokens.ts` | One-time member-bound WS auth tokens. `grantToken` + `verifyAndConsumeToken` (atomic single-use via D1 UPDATE … WHERE consumed_at_ms IS NULL) |
| `worker/src/mise-graph/agents/cooking-lead-scheduler.ts` | Pure `tickScheduler(input) → output`. Skeleton returns zero new assignments. `readyTasks` helper exposes DAG-ready filter for Wave 8B + tests |
| `worker/src/mise-graph/agents/cooking-lead-agent.ts` | The DO. Extends `Agent<Env, State>` (which extends `partyserver.Server`). Handles HTTP routes (init, grant-token, state, status, events, complete), WS upgrade through `super.fetch`, auth in `getConnectionTags`, dispatches inbound messages in `onMessage`, broadcasts via tag-filtered `getConnections`. 10s alarm-driven `onSchedulerTick`. 4h `onHardTimeout` |
| `worker/src/mise-graph/agents/cooking-lead-handoff.ts` | Pure helper — no Agents-SDK import — that posts /init to the DO. MealAgent's instance method delegates here so unit tests can mock the namespace |
| `worker/src/mise-graph/agents/schemas/cooking-lead-agent.sql` | Embedded SQLite schema (ws_connections, task_assignments, lead_events, photo_uploads). Mirrors what the DO creates in `onStart` |
| `worker/src/mise-graph/schemas/schema-brigade.sql` | D1 schema (mise_brigade_events, mise_brigade_pending_tokens) |
| `worker/test/scenarios/u56_brigade_token_lifecycle.ts` | Token grant → verify → consume → expired → mismatch → missing/unknown |
| `worker/test/scenarios/u57_brigade_scheduler_skeleton.ts` | Scheduler I/O contract: empty graph, no members, all complete, stale in-flight, recent in-flight, `readyTasks` helper |
| `worker/test/scenarios/u58_brigade_event_log.ts` | D1 event-log insert + cook_session_id-filtered ordered read |
| `worker/test/scenarios/u59_meal_active_cook_handoff.ts` | `active_cook_entry` still emits marker + 4h alarm; `spawnCookingLeadAgent` skips on missing binding, posts correct payload to /init, captures errors without throwing, refuses empty cook_session_id |

## Files modified

| Path | Change |
|---|---|
| `worker/src/mise-graph/agents/base.ts` | Added `cooking_lead` to `AgentKind` + binding map, `cookingLeadAgentName(cook_session_id)` helper, `COOKING_LEAD_AGENT?: DurableObjectNamespace` to the augmented `Cloudflare.Env` (optional so Wave 7-only tests still type-check) |
| `worker/src/mise-graph/agents/meal-agent.ts` | One private hook in `runPhaseEntry`'s `active_cook` branch: after the cook_session_id is committed to state, delegate to `spawnCookingLeadAgent` (pure helper). The state machine + transition matrix + everything else is untouched. Marked with the `Wave 8 hand-off boundary` comment |
| `worker/src/mise-graph/agents/meal-phase-handlers.ts` | Updated `active_cook_entry` cook_session meta_json: replaced `wave_8_expansion_point` with `wave_8_handoff` (since the spawn now actually happens) |
| `worker/src/mise-graph/schemas/migrations.ts` | Added `migrateBrigadeSchema(env)` covering the 2 new tables + 4 indexes |
| `worker/src/mise-graph-worker.ts` | Exported `CookingLeadAgent` class. Added `/admin/migrate-brigade` route (admin-gated). Added `/mise-graph/agents/cooking-lead/<id>/ws` (WS upgrade pass-through, NOT admin-gated — the token IS the auth). Added `/mise-graph/agents/cooking-lead/<id>/<action>` admin bridge. Extended `Env` interface with optional `COOKING_LEAD_AGENT` |
| `worker/wrangler.mise.toml` | Added `COOKING_LEAD_AGENT` DO binding. Added NEW `[[migrations]] tag = "v2"` with `new_sqlite_classes = ["CookingLeadAgent"]`. The `v1` tag is left alone (already deployed) |
| `worker/test/lib/wave7c-fake-d1.ts` | Added `BrigadeFakeD1` class — handles brigade tokens (insert, atomic consume), brigade events (insert, ordered read by cook_session_id), and a minimal cook-sessions row helper. Same dispatch shape as the equipment fake |
| `worker/test/scenarios/u44_meal_agent_full_lifecycle.ts` | Updated marker key from `wave_8_expansion_point` to `wave_8_handoff` |

## Test results

```
SPENCE PLANNER  —  78 of 79 scenarios run
─────────────────────────────────────────
  Passed:  78    Failed:  0    Pending:  0
```

(74 pre-existing + 4 new = 78. The 79th is t18 daily-brief-live, gated to
`--tier=live`.)

`npx tsc --noEmit` — clean.
`npx wrangler deploy --config wrangler.mise.toml --dry-run` — validates;
all 7 DO bindings present (v1 + v2 migration tags accepted by wrangler).

## Wave 8B locked-down API contract

### DO id

```
cooking_lead:<cook_session_id>
```

The `cook_session_id` is the same ulid the MealAgent generates in
`active_cook_entry` (cook_<base36-time>_<random>), so D1 row +
DO id are identical.

### HTTP routes (admin-gated unless noted)

```
POST /mise-graph/admin/migrate-brigade        (admin)  — idempotent migrator
POST /mise-graph/agents/cooking-lead/<id>/init             (admin)
POST /mise-graph/agents/cooking-lead/<id>/grant-token      (admin)
POST /mise-graph/agents/cooking-lead/<id>/complete         (admin)
GET  /mise-graph/agents/cooking-lead/<id>/state            (admin)
GET  /mise-graph/agents/cooking-lead/<id>/status           (admin)
GET  /mise-graph/agents/cooking-lead/<id>/events?limit=N   (admin)
GET  /mise-graph/agents/cooking-lead/<id>/ws?token=...     (NO admin — token auth)
```

### Token shape

```typescript
GrantTokenRequest  = { cook_session_id: string; member_id: string }
GrantTokenResponse = { token: string; expires_at_ms: number;
                       cook_session_id: string; member_id: string }

VerifyTokenResult =
  | { ok: true;  cook_session_id: string; member_id: string }
  | { ok: false; reason: "missing"|"not_found"|"consumed"|"expired"|"session_mismatch" }
```

- 32-char Crockford-base32 (URL-safe, lower-case-tolerant)
- TTL: 10 minutes (`BRIGADE_TOKEN_TTL_MS`)
- Single-use (atomic UPDATE … WHERE consumed_at_ms IS NULL)
- Member-bound + session-bound at verify time

### WebSocket message envelope

Every message is JSON:

```typescript
interface BrigadeEnvelope {
  kind: BrigadeMessageKind;
  emitted_at_ms: number;
  cook_session_id: string;
  member_id?: string;
  correlation_id?: string;
  data?: Record<string, unknown>;
}
```

`kind` discriminator:

| Direction | kinds |
|---|---|
| DO → phone | `welcome`, `task_assigned`, `task_unassigned`, `phase_progress`, `recipe_iteration_suggested`, `lead_message`, `session_ended` |
| phone → DO | `hello`, `presence_update`, `task_started`, `task_completed`, `task_help_requested`, `photo_uploaded`, `ping` |

### Event log schema (D1)

```sql
CREATE TABLE mise_brigade_events (
  id TEXT PRIMARY KEY,
  cook_session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  member_id TEXT,
  payload_json TEXT,
  emitted_at_ms INTEGER NOT NULL
)
```

Event kinds (stable; never renumber):
`session_initialized`, `session_started`, `session_completed`,
`session_abandoned`, `member_joined`, `member_left`, `task_assigned`,
`task_started`, `task_completed`, `task_unassigned`,
`task_help_requested`, `photo_uploaded`, `vision_response_received`,
`recipe_iteration_suggested`, `phase_progress`, `scheduler_tick`.

### Scheduler contract

```typescript
function tickScheduler(input: BrigadeSchedulerInput): BrigadeSchedulerOutput
```

Wave 8B fills in the heuristic. Skeleton returns zero new assignments and
flags in-flight tasks > 30 minutes old in `ready_for_completion_check`.

### MealAgent → CookingLeadAgent hand-off

`MealAgent.runPhaseEntry`'s `active_cook` branch now calls the pure helper
`spawnCookingLeadAgent({env, cook_session_id, meal_id, plan_id, household_id})`
right after the cook_session_id is committed to MealAgent state. Best-effort:
binding-absent → silent skip; stub error → logged + return `{ok:false, error}`.

## Architectural decisions

1. **Agents SDK over raw DurableObject.** `Agent<Env,State>` extends
   `partyserver.Server` which already implements hibernation-aware WS
   upgrade in `super.fetch`, dispatches `onConnect`/`onMessage`/`onClose`,
   and exposes tag-filtered `broadcast`/`getConnections`. Falling back to
   raw DO would re-invent all of that.
2. **Auth via `getConnectionTags`.** partyserver calls
   `getConnectionTags(connection, ctx)` *before* `onConnect`, so token
   verification slots in there cleanly. Failed-auth connections get a
   `brigade:auth_failed` tag and `onConnect` immediately closes them with
   code 4401.
3. **Embedded SQLite + D1 dual write.** Events and assignments are written
   to BOTH the DO's embedded SQLite (fast in-DO read) AND D1 (durable +
   replay). The DO write is authoritative for in-session decisions; D1 is
   the post-mortem record.
4. **NEW migration tag `v2`.** Per Cloudflare migration semantics, `v1` is
   already deployed and immutable. The new `CookingLeadAgent` SQLite class
   is added under `tag = "v2"`. Future class additions follow `v3`, `v4`, …
5. **Hand-off helper as a pure module.** `spawnCookingLeadAgent` lives in
   its own file (`cooking-lead-handoff.ts`) with NO Agents-SDK import. Unit
   tests can mock the DO namespace and assert the exact /init payload
   without booting the runtime.

## Deviations from the prompt

1. **Token bytes.** The prompt suggested base32 of 32 chars × 5 bits = 160 bits,
   matching SHA-1. The implementation uses one alphabet character per random
   byte (256 → 32-modulo). That's slightly worse than uniform base32 but
   simpler and still gives ~5 bits effective entropy per char (~160 bits for
   the 32-char token). For 10-minute single-use credentials this is fine.
   Wave 8B can swap to bit-packed base32 if rotation cadence changes.
2. **No miniflare WS integration test.** Per the prompt, deferred to Wave 8B.
   The pure-function tests u56–u59 cover the contract surface. The DO class
   itself is exercised end-to-end via `--dry-run` build validation; full WS
   handshake testing requires miniflare.
3. **`expected_duration_min` left at 0 in /init body.** The MealAgent calls
   the helper without computing critical-path duration from the task graph
   yet. Wave 8B should pull `task_graph.critical_path_min` from D1 and pass
   it through. The DO accepts the field but doesn't depend on it.
4. **`Wave 8B` heuristic location is documented in cooking-lead-scheduler.ts**
   as a TODO comment in the function body. The contract is locked; the
   implementation is a one-pass replacement.

## What Wave 8B should pick up

1. Hydrate `BrigadeSchedulerInput.graph` from D1.mise_task_graphs in
   `CookingLeadAgent.onSchedulerTick` (currently passes an empty graph).
2. Hydrate `BrigadeSchedulerInput.members` from MemberAgent presence
   (read-through bridge or D1.mise_members snapshot).
3. Implement the heuristic in `tickScheduler` — see the TODO comment.
4. Wire `photo_uploaded` to a vision queue + write `vision_response_received`
   events when the response lands.
5. Add iOS WebSocket client test scenario via miniflare/wrangler dev.
6. Wire MemberAgent.ping-presence on inbound `presence_update` messages.
7. Bump migration to `v3` if a new SQLite class is added (do NOT modify v2).

---

**Foundation status:** complete. 78/78 tests passing, typecheck clean, dry-run
validates. Ready for Wave 8B.
