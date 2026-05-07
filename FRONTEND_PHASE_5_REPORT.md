# Spence Frontend — Phase 5 Report

> Cook mode for the web app. Full-screen, dark, WebSocket-driven kitchen UI
> connected to `CookingLeadAgent`. Big text, hands-free buttons, screen-on,
> photo capture with vision feedback inline.

## What landed

Hits `/cook/[cook_session_id]`. Server pre-fetches `brigade_get_state`,
client mints a single-use token via `/api/cook/token` (admin-bridged
`brigade_grant_token`), opens `wss://…/cooking-lead/<id>/ws?token=…&member_id=…`,
acquires Wake Lock, and renders the live kitchen surface.

## WebSocket contract documented

`web/lib/brigade-ws.ts` mirrors the worker `BrigadeMessageKind` enum.

- **Outbound (phone → DO):** `ping`, `presence_update`, `ack_task`,
  `complete_task`, `request_help`, `decline_task`, `iteration_response`,
  `photo_uploaded`. Auto-stamps `cook_session_id` + `member_id`.
- **Inbound (DO → phone):** `welcome`, `task_assigned`, `task_unassigned`,
  `task_completed`, `task_started`, `task_help_requested`, `phase_progress`,
  `recipe_iteration_suggested`, `lead_message`, `session_ended`,
  `member_joined`, `member_left`, `pong`.
- Reconnect: exponential backoff (500ms → 30s, ±25% jitter) with token
  refresh callback on every attempt (the previous token was consumed at
  WS upgrade).

## Components shipped

`active/`: `active-cook.tsx` (the WS reducer + layout), `your-task`,
`other-members`, `recipe-timeline`, `event-log`, `photo-capture`,
`iteration-suggestion`, `connection-status`, `exit-cook`. Plus the
shell-hiding `layout.tsx` and pre-cook `page.tsx`. New CSS tokens
`--color-ink-deep/-surface/-surface-2/-cream-dim/-cream-faint` and the
`.cook-bg` / `.cook-active-glow` classes (reduced-motion aware).

## Photo flow

Browser camera intent (`<input capture=environment>`) → client resize via
`lib/photo-resize.ts` (≤1024px) → POST to `/api/cook/photo-upload` (server
mints fresh brigade token + forwards bytes to worker `/upload-photo`) →
"Analyzing…" pill → analysis returns over WS as `recipe_iteration_suggested`
or `lead_message{event:"photo_analyzed"}`. One automatic retry on transient
failures.

## Tests + storybook vs live

- Vitest: 9/9 passing, including 6 new BrigadeWS tests using the
  `MockWebSocket` helper (open, send envelope shape, malformed-frame skip,
  reconnect-with-fresh-token, suppressed-reconnect-on-close).
- Stories: `YourTask` (idle/active/awaiting/done), `OtherMembers`,
  `RecipeTimeline`, `EventLog`, `ConnectionStatus`, `IterationSuggestion`.
- Typecheck clean for all Phase-5 paths.

**Storybook-verified:** all components render in their variant matrix.
**Needs live brigade:** end-to-end WS handshake, token consumption,
photo-upload → vision → iteration round-trip, multi-member presence.
The worker `e2e-brigade.sh` proves the HTTP/MCP surface; this client now
plugs into it.

## Files touched

Created: 14 files under `web/app/cook/[cook_session_id]/`,
`web/app/api/cook/{token,photo-upload}/route.ts`, `web/lib/brigade-ws.ts`,
`web/lib/photo-resize.ts`, `web/__tests__/{mock-ws.ts,brigade-ws.test.ts}`,
6 stories. Modified additively: `web/lib/mcp.ts` (brigade_* ToolMap entries,
`BrigadeTokenGrant` / `BrigadeStateResult` types) and `web/app/globals.css`
(dark cook tokens + glow keyframes). Untouched: `chef-agent.ts`, `auth.ts`,
`primitives/*`, `chef/*`, other phases.
