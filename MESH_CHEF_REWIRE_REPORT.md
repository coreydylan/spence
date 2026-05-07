# Mesh-Claude Chef Rewire — Phase 1

The chef-of-staff agent loop now lives on the worker and routes through the
mesh-claude bridge (Corey's CC subscription), not the Anthropic API.

## Worker route added

`POST /agent/chef` on `mise-graph` (file: `worker/src/mise-graph/agent-chef-route.ts`).
Wired in `worker/src/mise-graph-worker.ts`.

- Resolves `household_id` from body, else slugifies `Cf-Access-Authenticated-User-Email`
  (same convention as `web/lib/auth.ts`).
- Runs `chef_status_check`. On `answer_onboarding_question` + non-empty
  `blocked_actions`, emits `ui_component(onboarding_question)` and stops.
- Otherwise builds a chef-of-staff persona prompt (personality summary,
  condensed traditions, equipment, avoidances, curated tool catalog) and
  calls `callMeshClaude` (model `claude-sonnet-4-6`).
- Streams the bridge's text back as ~50-char fragments with a 30 ms gap to
  give a typing cadence (the bridge itself is non-streaming).
- Per-route CORS wrapper: allows `*.workers.dev`, `localhost:3000/127.0.0.1:3000`,
  permissive fallback otherwise; handles OPTIONS preflight.

SSE event shapes: `{kind:"status",status}` · `{kind:"ui_component",component}` ·
`{kind:"thinking_start"}` · `{kind:"text",delta}` · `{kind:"error",message}` ·
`{kind:"done",reason}`.

Test: `worker/test/scenarios/u111_agent_chef_route.ts` (gating, ready→bridge,
bridge error, missing auth → 401, OPTIONS preflight, SSE wire format).
Worker suite: 130/130 green.

## Web side proxy diff

- `web/lib/chef-agent.ts` rewritten as a thin proxy: POST to
  `${WORKER_URL}/agent/chef`, parse SSE frames, yield each as a `ChefEvent`.
  Same exported types (`ChefEvent`, `UiComponent`) — chat surface unchanged.
- `web/app/api/chef/route.ts` unchanged in surface; auth + SSE relay still here.
- `web/app/chat/page.tsx` learned the new `thinking_start` event (no-op).
- `web/__tests__/agent-loop-smoke.test.ts` rewritten to mock `fetchImpl`.
  Web suite: 23/23 green.

## Anthropic SDK removed

`@anthropic-ai/sdk` removed from `web/package.json` dependencies and
`node_modules`/`package-lock.json`. The chat UI is unaffected — same event
types, same components, same `/api/chef` URL. Only the upstream changed
(worker → mesh bridge instead of Anthropic API).

## Deploy verified

- Worker: deployed to `mise-graph` (version `844a1b30`).
- Web: deployed to `spence-web` (version `8211a051`).
- `curl -N -X POST .../agent/chef -d '{"household_id":"hh_dialed_in","message":"hi"}'`
  returned status → thinking_start → text deltas → done. Bridge replied
  ~"Hey! What's on your mind — dinner tonight, or something else?".

## TODO Phase 2 — Tool-routing pass

Bridge response is plain text only. Phase 2 should parse responses for
explicit tool-call hints (e.g. `[[tool: plan_read_meal {…}]]`), execute via
`callPlanWorldTool`, and either re-prompt the bridge with the result or
emit `tool_call_start` / `tool_call_result` directly. The web client already
handles those SSE events.
