# Phase 3 — Workers AI Intent Router

A cheap fast classifier (`@cf/meta/llama-3.2-3b-instruct`, max_tokens 64,
temperature 0) sits at the top of `/agent/chef`. It runs after `chef_status_check`
and the onboarding gate, but BEFORE any mesh-claude bridge round-trip. On any
failure (missing AI binding, model error, parse error, confidence <0.6) it
returns `free_chat` and we fall through to the existing Code Mode + bridge
loop unchanged. Users are never blocked by the router.

## Classifier prompt

One-shot system + user. The system message pins the model to JSON-only output;
the user message includes 8 labeled examples (one per intent) followed by the
user's message. JSON is parsed with a brace-balanced extractor that tolerates
```json fences and preamble text. Internal quotes in the user message are
escaped before interpolation.

## Intents and handlers

| Intent | Handler | Bridge? |
|---|---|---|
| `free_chat` | fall through to existing Code Mode + bridge loop | yes |
| `workflow:onboard` | fall through (Phase 2 will hook `env.ONBOARDING_WORKFLOW.create`) | yes (today) |
| `workflow:plan` | fall through (Phase 2 will hook `env.PLANNING_WORKFLOW.create`) | yes (today) |
| `workflow:debrief_meal` | fall through (Phase 2 will hook `env.COOK_DEBRIEF_WORKFLOW.create`) | yes (today) |
| `quick:save_preference` | `member_list` → `member_update_preferences` per adult | **no** |
| `quick:add_to_pantry` | `household_set_pantry_bulk` (mode=text) | **no** |
| `quick:add_equipment` | `household_set_equipment_bulk` | **no** |
| `quick:set_tradition` | `household_set_traditions` | **no** |

`household_id` is forced into every dispatched tool call (no impersonation).
Quick paths emit a confirmation `text` event then `done(stop)`. The
`save_preference` "no adults" edge case falls through so the bridge can ask
for the missing context.

## Latency

Production smoke-test against the deployed worker
(`mise-graph.9f745064e644311ed09914b9a12e9c7380ce62b7.workers.dev`):

- `quick:add_to_pantry` end-to-end (status + classify + direct MCP write + done): **815ms total**
- `free_chat` (classify + bridge): ~10s (classifier ≪ bridge)
- vs. pre-Phase-3 baseline: every chat hit the bridge regardless of intent (10s+ even for "we are vegetarian")

Classifier latency target (<100ms) is met inside that 815ms total — the rest
is HTTP, status check, MCP write, and chunked SSE.

## Tests

- `worker/test/scenarios/u121_intent_classifier.ts` — 70 assertions: 8 intent
  kinds round-trip; JSON-fence + preamble parsing; malformed JSON / low
  confidence / missing details / missing AI binding / classifier throw all
  fall back to `free_chat`; empty message short-circuits.
- `worker/test/scenarios/u122_chef_route_intent_branch.ts` — 45 assertions:
  each quick intent dispatches the right MCP tool with `household_id` forced
  and bridge call count == 0; `free_chat` and `workflow:*` fall through to
  the bridge; `save_preference` with no adult members falls through.
- Full suite: **138/138 pass.** `npx tsc --noEmit` clean for new code (only
  pre-existing Phase 2 workflow type errors remain — outside scope).

## Deploy verification

`wrangler deploy --dry-run` shows `env.AI` binding alongside the workflow
bindings. Deployed via the global API key path (VPC-bound worker). Verified
SSE event order: `status` → `intent` → `tool_call_start` → `tool_call_result`
→ `text` → `done(stop)` with **bridge never invoked** for `quick:*` paths.

## Files

- Created: `worker/src/mise-graph/intent-router.ts`
- Modified: `worker/src/mise-graph/agent-chef-route.ts`, `worker/src/mise-graph/types.ts`, `worker/wrangler.mise.toml`
- Tests: `worker/test/scenarios/u121_intent_classifier.ts`, `worker/test/scenarios/u122_chef_route_intent_branch.ts`
