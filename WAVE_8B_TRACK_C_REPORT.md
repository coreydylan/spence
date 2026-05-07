# Wave 8B Track C Report — Brigade MCP Tools + WS Handlers + Manual Control

## Scope

Wave 8B Track C adds the chef-of-staff manual control + observation surface
on top of the Wave 8 brigade foundation:

- 11 brigade-mode MCP tools wired into `plan-world-mcp.ts`
- 5 new WebSocket message kinds dispatched in `cooking-lead-agent.ts`
- 8 new manual control HTTP routes on the CookingLeadAgent DO (+ 3 friendly
  URL aliases)
- A pure skill-outcome fan-out helper so brigade completions feed the
  long-lived MemberAgent skill model
- A `routeCookingLead` helper in `agents/router.ts`
- 5 new test scenarios (u72-u76) covering the routing + lifecycle contracts

Wave 8 foundation locked the runtime + storage + auth + hand-off contract.
Wave 8B Track A (scheduler heuristic) and Track B (photo + vision pipeline)
ship in parallel; Track C provides the human-in-the-loop surface.

## Files modified

| Path | Change |
|---|---|
| `worker/src/mise-graph/plan-world-mcp.ts` | Added 11 brigade_* MCP tool dispatch cases + 11 tool catalog entries + 11 thin handler functions (`toolBrigadeStart`, `toolBrigadeGrantToken`, `toolBrigadeGetState`, `toolBrigadeGetEventLog`, `toolBrigadeAssignManually`, `toolBrigadeUnassign`, `toolBrigadeMarkComplete`, `toolBrigadeSendMessage`, `toolBrigadePause`, `toolBrigadeResume`, `toolBrigadeEnd`). Each write tool wraps in `withTrace` so the override is auditable. |
| `worker/src/mise-graph/agents/cooking-lead-agent.ts` | (a) Added imports: `memberAgentName`, `fanOutBrigadeSkillOutcome`. (b) Added `ManualAssignBody` / `ManualUnassignBody` / `ManualCompleteBody` / `SendMessageBody` / `EndSessionBody` body shapes. (c) Added 9 new HTTP route dispatchers in `onRequest` (`start` alias / `manual-assign` + `assign` alias / `manual-unassign` / `manual-complete-task` + `complete-task` alias / `send-message` / `pause` / `resume` / `end` / `get-state` / `event-log`). (d) Extended `onMessage` switch with 5 new WS kinds (`ack_task`, `complete_task`, `request_help`, `decline_task`, `iteration_response`) + replaced the `ping` and `presence_update` stubs with real handlers. (e) Added 19 new private methods covering the manual control + WS handlers + skill fan-out delegate + the `computeBrigadeSummary` / `readEventsSince` read helpers. (f) Added a manual-pause short-circuit in `onSchedulerTick` so paused sessions re-arm but emit zero new assignments. |
| `worker/src/mise-graph/agents/cooking-lead-types.ts` | Extended `CookingLeadState` with optional `paused`, `paused_at_ms`, `last_pause_reason` fields. Optional so foundation scenarios still type-check. |
| `worker/src/mise-graph/agents/router.ts` | Added `COOKING_LEAD_AGENT?` to `AgentEnvShim`, imported `cookingLeadAgentName` from `base.ts`, exported `routeCookingLead(env, cook_session_id, action, payload?, method?)` helper, re-exported `cookingLeadAgentName`. Best-effort sidecar pattern — never throws. |

## Files created

| Path | Purpose |
|---|---|
| `worker/src/mise-graph/agents/brigade-skill-fanout.ts` | Pure skill-outcome fan-out helper. POSTs to `MemberAgent.skill-outcome`. Best-effort: missing binding / household / member / task → silent skip with reason. Stub fetch errors caught + logged. Tested in u74 without booting the SDK. |
| `worker/test/scenarios/u72_brigade_mcp_tool_routing.ts` | 36 assertions covering all 11 brigade_* MCP tools: DO id format (`cooking_lead:<id>`), action route names, body payload shape, ws_url synthesis, D1-direct event-log read (no DO hop), missing-binding error shape. |
| `worker/test/scenarios/u73_brigade_ws_message_dispatch.ts` | 16 assertions on `routeCookingLead` contract: POST default, GET explicit, missing binding → null, empty cook_session_id → null, repeated calls share DO id. The WS kinds themselves are exercised by u72/u74/u75/u76. |
| `worker/test/scenarios/u74_brigade_completion_skill_fanout.ts` | 24 assertions on `fanOutBrigadeSkillOutcome`: happy path with all fields, 4 skip paths (missing binding / household / member / task), thrown stub error caught, custom skill_name pass-through. |
| `worker/test/scenarios/u75_brigade_manual_assign_override.ts` | 25 assertions on the override flow: `brigade_assign_task_manually` / `_unassign_task` / `_mark_task_complete` (named + anon) all route correctly, trace persists to D1, missing required args throw at the caller, every override targets the same `cooking_lead:<id>` DO. |
| `worker/test/scenarios/u76_brigade_pause_resume.ts` | 23 assertions on the pause / resume / end lifecycle: routes flip paused state correctly, outcome propagates (completed / abandoned / default-completed), traces persist, distinct cook_session_ids → distinct DO ids. |

## MCP tools added (11)

| Tool | Purpose |
|---|---|
| `brigade_start` | Initialize the CookingLeadAgent for a cook session. Routes to `/init`. Idempotent. |
| `brigade_grant_token` | Grant a one-time, member-bound, 10-minute WS auth token. Returns `{token, expires_at_ms, cook_session_id, member_id, ws_url}`. ws_url is synthesised from the token + member_id. |
| `brigade_get_state` | Read brigade live state + summary (paused, connected_members, in_flight_assignments, completed_count, total_assignments, expected_completion_at_ms). Routes to `/get-state`. |
| `brigade_get_event_log` | Replay-ready event log. Reads from D1.mise_brigade_events directly (post-hibernation safe — bypasses the DO). |
| `brigade_assign_task_manually` | Override the auto-scheduler — pin a task to a member. Routes to `/manual-assign`. Trace-wrapped. |
| `brigade_unassign_task` | Free a stuck task back to the pool. Marks all in-flight rows as `outcome='reassigned'`. Trace-wrapped. |
| `brigade_mark_task_complete` | Lead/admin marks complete on a member's behalf. Optional member_id; if omitted, marks every in-flight assignment for the task. Fans out skill-outcome to MemberAgent. |
| `brigade_send_message` | Push a chef-of-staff voice message — broadcast or member-targeted. Surfaces as a `lead_message` on the phone WS. |
| `brigade_pause` | Pause scheduler tick. Tick re-arms but emits zero new assignments. |
| `brigade_resume` | Resume scheduler tick after a pause. |
| `brigade_end` | Mark session as completed or abandoned. Broadcasts `session_ended` to all members. |

All write tools wrap in `withTrace` so the override is auditable.

## WS message handlers added (5 new + 2 replaced stubs)

| Kind | Handler behaviour |
|---|---|
| `ack_task` | Member acknowledges assignment. Sets `started_at_ms` on the assignment row. Logs `task_started` with `ack: true`. |
| `complete_task` | Member completes task with outcome (success/partial/retry/failure). Updates assignment, logs `task_completed`, fans out to MemberAgent.skill-outcome. |
| `request_help` | Member asks for assist. Broadcasts a `lead_message` with `kind: "help_request"` to all OTHER members (the requester is excluded). |
| `decline_task` | Member can't take it. Marks the assignment row `outcome='reassigned'`, logs `task_unassigned`. Scheduler re-picks on next tick. |
| `iteration_response` | Member accepts/rejects vision-suggested iteration. Records in event log as `recipe_iteration_suggested` with `response: true`. |
| `presence_update` (replaced stub) | Records `phase_progress` event locally + forwards to `MemberAgent.ping-presence` so the global presence cache stays in sync. |
| `ping` (replaced stub) | Now responds with `{kind: "pong", emitted_at_ms, cook_session_id, member_id}` so phones can detect dead sockets. |

## HTTP routes added on the CookingLeadAgent DO

All admin-gated by the existing `/mise-graph/agents/cooking-lead/*` bridge.
The friendly URLs are aliases — the canonical actions are listed first.

| Route | Method | Purpose |
|---|---|---|
| `/manual-assign` (alias: `/assign`) | POST | Pin task to member. |
| `/manual-unassign` | POST | Free stuck task. |
| `/manual-complete-task` (alias: `/complete-task`) | POST | Mark complete on behalf of member. |
| `/send-message` | POST | Targeted or broadcast lead message. |
| `/pause` | POST | Pause scheduler tick. |
| `/resume` | POST | Resume scheduler tick. |
| `/end` | POST | Mark session completed/abandoned. |
| `/start` (alias for `/init`) | POST | Initialize brigade session. |
| `/get-state` | GET | State + brigade summary. |
| `/event-log?since=&limit=` | GET | Filtered event log read. |

The bridge worker route at `/mise-graph/agents/cooking-lead/<id>/<action>`
already forwards any action to the DO, so no new bridge routes are needed
in `mise-graph-worker.ts`. The existing dispatcher handles all 10 new DO
routes verbatim.

## Skill outcome fan-out

When a member completes a task (via WS `complete_task` OR via the lead's
`brigade_mark_task_complete`), the DO calls `fanOutBrigadeSkillOutcome`:

```
brigade complete → CookingLeadAgent.fanOutSkillOutcome
                 → fanOutBrigadeSkillOutcome (pure helper)
                 → POST /skill-outcome on MemberAgent[hh:member]
```

The fan-out is best-effort: missing MEMBER_AGENT binding, missing household,
or thrown stub error → silent skip with reason. The brigade event log is
authoritative; MemberAgent is a sidecar.

`skill_name` defaults to `"general"` until Wave 8B Track A wires the task
graph's per-task skill through the assignment row.

## Test results

```
SPENCE PLANNER  —  95 of 96 scenarios run
─────────────────────────────────────────
  Passed:  95    Failed:  0    Pending:  0
```

(95 passed = baseline 88 + my 5 new (u72-u76) + 2 from concurrent Tracks A/B
that landed during the work. The 96th is t18 daily-brief-live, gated to
`--tier=live`.)

`npx tsc --noEmit` — clean.
`npx wrangler deploy --dry-run --config wrangler.mise.toml` — validates;
all 7 DO bindings (Wave 7 + Wave 8) present.

## Coordination notes

- **Track A** added scheduler heuristic + scheduler-input hydration helpers
  to `cooking-lead-agent.ts`. We added our manual control + WS dispatch
  surfaces in dedicated comment-marked sections; no edit conflicts.
- **Track B** added photo + vision routes (`upload-photo`, `photo`,
  `photo-analysis`, `photos`) to `cooking-lead-agent.ts` AND added an
  `iteration_note` column to the `task_assignments` schema. We use
  `task_assignments` only via additive INSERT/UPDATE on the existing PK
  columns; no schema collisions. The new `iteration_response` WS handler
  is wire-compatible with the field Track B writes.
- The state extension on `CookingLeadState` (`paused?`, `paused_at_ms?`,
  `last_pause_reason?`) is optional, so foundation scenarios + Track A/B
  type-check without changes.

## Architectural decisions

1. **Friendly URL aliases.** The prompt asked for `/start`, `/assign`,
   `/complete-task` URL shapes. The existing DO routes use `/init`,
   `/manual-assign`, `/manual-complete-task` — we accept both names so the
   new bridge URLs feel natural while preserving the foundation surface.
2. **D1-direct event-log read.** `brigade_get_event_log` reads from
   D1.mise_brigade_events directly, not via the DO. This is intentional:
   the DO hibernates (the embedded SQLite mirror is fast, but only while
   warm); D1 is the durable post-mortem record for replay UIs. Tested in
   u72.
3. **Skill fan-out as a pure helper.** Extracted to
   `brigade-skill-fanout.ts` so the contract is unit-testable without
   booting the Agents SDK. The DO method delegates.
4. **Manual pause short-circuits the tick, not the alarm.** When paused,
   the alarm still fires every 10s — the tick records a `paused: true`
   payload and re-arms, but emits zero assignments. This keeps the alarm
   chain warm so resume is instant, and gives the timeline a visible
   "paused" heartbeat for debug.
5. **`request_help` excludes the requester from the broadcast.** The
   help broadcast goes to all OTHER members so an idle hand can jump in;
   the requester doesn't need to see their own request echoed back.
6. **Trace wrapping for write tools.** Every brigade_* tool that mutates
   state (`start`, `assign`, `unassign`, `mark_complete`, `send_message`,
   `pause`, `resume`, `end`) is wrapped in `withTrace`. Read tools
   (`get_state`, `get_event_log`, `grant_token` — token grant is logged
   inside the DO) are not. This matches the existing plan_* convention.

## Deviations from the prompt

1. **No new top-level bridge routes added to `mise-graph-worker.ts`.** The
   existing `/mise-graph/agents/cooking-lead/<id>/<action>` admin bridge
   already forwards any action to the DO, so my 8 new DO routes are
   reachable without any worker changes. Adding per-action handlers in
   the worker would duplicate the dispatch. The WS upgrade route also
   already exists. Per the prompt: "Keep ~5 lines each" — keeping zero
   lines each was even cleaner.
2. **No miniflare WS handshake test.** Per the foundation report's
   guidance: WS hibernation testing requires miniflare and is deferred
   to a later wave. The dispatch shape is exercised via u72/u73/u74/u75/u76
   without spinning up partyserver.
3. **`task_assigned` event uses the foundation `BrigadeEventKind`.** The
   `manual: true` marker is in the payload, not a new kind, so older
   replay UIs continue to render correctly.

## What Wave 8C+ should pick up

1. Wire the WS `member_id` query param in the DO upgrade so the phone
   client can identify which member it's connecting as without parsing
   the token (currently the token IS the auth — we just expose
   `member_id` in the ws_url for client convenience).
2. Migration to v3 if a new SQLite class is added (do NOT modify v2).
3. Pass the per-task `skill_name` from the assignment row into
   `fanOutBrigadeSkillOutcome` so the MemberAgent records skill confidence
   under the actual skill (knife/saute/dough/...) instead of the
   `"general"` placeholder.
4. Voice surface (Siri/Alexa) hooks into `brigade_send_message` for the
   chef-of-staff voice channel.
5. Live UI for the lead's manual control surface (web client driving the
   brigade_* tools).

---

**Track C status:** complete. 95/96 tests passing, typecheck clean,
dry-run validates. Ready for the Wave 8B integration test.
