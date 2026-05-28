# Chef-of-Staff Tool Routing — Phase 2

The `/agent/chef` route on `mise-graph` now actually dispatches MCP tools
instead of hallucinating about them.

## Wire format

Claude emits raw envelopes in its bridge response:

```
[[TOOL_CALL]]
{"name": "<tool_name>", "args": { ... }}
[[/TOOL_CALL]]
```

`parseToolCalls()` finds every block (regex), JSON-parses each body,
strips the blocks from the leading text, and ignores malformed envelopes.
Tool results are fed back as `[[TOOL_RESULT name=… ]] …json… [[/TOOL_RESULT]]`
in a follow-up prompt that also carries the previous user prompt + the
previous assistant text.

## Iteration loop

`runAgentChef` runs at most **4 bridge round-trips** per user turn
(`MAX_ITERATIONS = 4`, ~3-4 min worst case). Each round emits
`iteration_start { iteration_n }` so the UI can show progress. When the
bridge's reply has zero tool calls, the loop streams that reply as
`text` deltas and emits `done`. When the cap is reached, the loop falls
through with a graceful "I hit the cap" fallback (or the leading text
Claude already wrote) so the user is never left hanging.

## Allow-list (33 tools)

Curated from ~120 in `callPlanWorldTool`. Reads cover signals, plan
state, seasonality, weather, calendar, recent menu, format/flavor
libraries, recipe steps. Plan writes limited to safe verbs (create /
compose / replace / cancel / audit) — no locking, splitting, sliding,
or ledger ops. Member tools cover the common preference-save cases
(`member_create`, `member_update_preferences`, `member_update_safety`).
Household setters cover bulk pantry / equipment / traditions. Anything
off-list emits `tool_call_error { message: "tool not allowed" }` so
Claude can adapt naturally — same shape as a runtime tool failure.

## Security: forced household_id

Every tool call's `household_id` arg is overwritten with the route's
resolved household_id (from CF Access header or body) regardless of
what Claude tries to specify. Plan-scoped tools (e.g. `plan_read_meal`)
that accept a `plan_id` instead skip the override.

## Truncation

`stringifyToolResult()` keeps tool payloads within ~3 KB. First it
truncates oversized string fields with a `…[truncated N chars]` marker;
if the result is still too big, it wraps the head in a synthetic
`{__truncated, original_bytes, head_preview, note}` envelope that's
always JSON-valid. The `truncated: true` flag rides on the SSE
`tool_call_result` event so the UI can hint at it.

## Test coverage

`u111_agent_chef_route.ts` — 6 new sub-cases:
- `parseToolCalls` (none / single / multiple / malformed)
- `stringifyToolResult` budget + JSON validity
- single tool call → dispatch → second iteration → final text
- multiple tool calls in one bridge response → both dispatched
- disallowed tool name (`plan_lock_meal`) → `tool_call_error`, never
  reaches dispatcher
- bridge response without tool calls → final text path
- iteration cap reached → terminal `done` after exactly N iterations

Worker suite: 130/130 green. `npx tsc --noEmit` and
`wrangler --dry-run` both clean.

## Live verification

```bash
curl -sN -X POST 'https://mise-graph.…workers.dev/agent/chef' \
  -H 'Content-Type: application/json' \
  --data '{"household_id":"hh_…","message":"check my plans with plan_list"}'
```

Returns: `status` → `thinking_start` → `iteration_start n=1` →
`tool_call_start { tool:"plan_list" }` → `tool_call_result { plans:[] }`
→ `iteration_start n=2` → `text` deltas → `done`. Confirmed against
deployed version `4f83a6bd-09dd-4a09-adcc-1ec7a90723f9`.

## Known limitations

- Sequential dispatch within an iteration — multiple tools in one
  bridge response run in series, not parallel. Fine for the current
  catalog; revisit when read-only fan-out matters.
- No partial streaming during tool dispatch — the user sees thinking +
  iteration markers but no narration between calls. Acceptable since
  each iteration is < ~30 s.
- Tool-result truncation is JSON-aware but not field-priority-aware
  — a giant `plan_read_map` markdown blob gets the synthetic head
  envelope; the fielded structure is lost. Worth a per-tool
  summarizer hook later if maps become routine.
- Allow-list is hand-curated — when new tools land in `plan-world-mcp`
  they need to be added here explicitly. Documented inline.
