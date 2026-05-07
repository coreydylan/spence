# Wave 8 — Brigade Live-Drive Report

## Verdict

**Architecturally complete for HTTP/MCP control. Ready for first phone test.**
Every brigade control surface that doesn't require a real WebSocket was
driven end-to-end against the deployed worker. The MealAgent →
CookingLeadAgent hand-off fires on `active_cook`; the brigade DO accepts
admin + MCP traffic while hibernation-safe; D1 event log is durable; photo
upload writes to R2 + embedded SQLite.

## What works end-to-end (HTTP/MCP)

Driver: `worker/scripts/e2e-brigade.sh` — 23 idempotent ✓ steps.

- Migrations (`migrate-wave-7`, `migrate-brigade`).
- 2 adult members, curry meal with `stovetop_burner` + `rice_cooker`,
  `plan_finalize` spawns MealAgent.
- Force MealAgent `planned → pre_eve → day_of → cook_window → active_cook`
  via the `/transition` route. `cook_session_id` populated by
  `active_cook_entry` (live id `cook_movau256_wkjugb`).
- `GET /agents/cooking-lead/<id>/state` returns `status:"active"` — Wave 8
  hand-off proven.
- `brigade_grant_token` × 2 — 32-char Crockford base32, +10min TTL, `ws_url`
  returned.
- `brigade_get_state` pre/post — connected_members, in_flight, totals all
  correct.
- `brigade_assign_task_manually` → `brigade_mark_task_complete` round-trip
  writes `task_assignments` rows + matching events.
- `brigade_get_event_log` — D1-backed durable replay.
- `brigade_send_message`, `pause`, `resume`, `end` — all flip state + emit
  events.

## Sample event log (real cook session)

```
session_initialized      keys=[cook_session_id, expected_duration_min, meal_id, plan_id]
task_assigned            mem_alice   keys=[manual, reason, task_id]
task_completed           mem_alice   keys=[marked_by, notes, outcome, task_id]
phase_progress                       keys=[broadcast, lead_message]    # send-message
phase_progress                       keys=[at_ms, paused]              # pause
phase_progress                       keys=[at_ms, paused]              # resume
session_completed                    keys=[cook_session_id, ended_by, notes]
```

## Stubbed but reachable

- **Photo upload**: 1 KB payload → R2 PUT, `photo_uploads` row written,
  `photo_id` returned.
- **Vision callback**: live worker's vision bridge returns 404, so DO records
  graceful fallback analysis. Pipeline (R2 + sqlite + analysis insert +
  `vision_response_received` event) is wired; only the upstream LLM is unbound.
- **Scheduler tick**: fires every 10 s; emits `scheduler_tick` events. With a
  real task graph + `presence_update` frames it would assign.

## Needs a real WS client (not curl-able)

Member-side inbound frames: `ack_task`, `complete_task`, `request_help`,
`decline_task`, `iteration_response`, `presence_update`, `ping`. Covered by
unit tests:

- `u73_brigade_ws_message_dispatch.ts` — routeCookingLead contract.
- `u72_brigade_manual_control.ts` — manual surface.
- `u74_brigade_skill_fanout.ts` — skill-outcome fan-out.
- `u59_meal_active_cook_handoff.ts` — MealAgent ↔ CookingLead spawn.

## Test suite

`npm test` → **126 passed, 0 failed**. No production code modified.

## To unlock first phone cook

1. iOS WS client that opens `wss://<worker>/mise-graph/agents/cooking-lead/<csi>/ws?token=<t>&member_id=<m>` and handles the 7 inbound kinds.
2. Live recipe → task-graph compile so the scheduler has real tasks (Wave 7C task graphs already produce these).
3. Wire the vision bridge endpoint (currently 404).
4. Out-of-band token delivery (push or SMS) — MCP returns the token but doesn't push it.
