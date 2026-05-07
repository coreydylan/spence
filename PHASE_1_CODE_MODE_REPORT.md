# Phase 1: Code Mode for MCP — Report

## Public API of `worker/src/mise-graph/code-mode.ts`

```ts
searchTools(query, limit?) -> SearchResult                  // catalog filter
executeCode(env, ctx, code, opts?) -> Promise<ExecuteResult> // run JS sandbox
parseCodeBlocks(text) -> CodeParseResult                    // [[CODE]]…[[/CODE]]
buildExecuteResultBlock(result, limit?) -> string           // [[EXECUTE_RESULT]]
ensureRequired(args, schema, ctx)                           // auto-inject hh_id
truncateResult(result, limit?)                              // 3 KB cap
interpretSubset(code, ctx)                                  // Workers fallback
```

`PLAN_WORLD_TOOLS` is now exported from `plan-world-mcp.ts` so Code Mode can iterate the full ~60-tool catalog at search time.

## Sandbox safety properties

The runtime tries `new AsyncFunction(...)` first (works in Node tests). Cloudflare Workers blocks that with `Code generation from strings disallowed`, so we fall through to a tree-walking interpreter (`interpretSubset`) covering the JS subset Claude actually emits: `const`/`let`/`var` (with array+object destructure), `await mcp(...)`, `await Promise.all([...])`, member chains with `?.` / `??`, `for (… of …)`, `if/else`, `try/catch`, `throw`, `return`, `console.log`, `Date.now()`, `new Date(...)`, simple `===`/`!==`, string/number `+`. Anything outside throws a clear parse error that surfaces to the agent as `ok:false`.

Three blast-radius caps: `timeout_ms` (30 s default, `Promise.race`), `max_tool_calls` (12 default), and the chef wrapper's allow-list gate. `household_id` is force-injected from context — the LLM cannot impersonate another household.

Limits: not a hard isolate. Code can still read globals (`Date`, `JSON`, `crypto`). For Phase 1.5 we should swap to the Worker Loader binding for true V8 sandboxing.

## System prompt updates (`agent-chef-route.ts`)

Replaced the single-tool `[[TOOL_CALL]]` envelope with **Code Mode primary + `[[TOOL_CALL]]` fallback**. Added two worked examples (read-only tonight check; vegetarian member update) plus a "compose multiple calls in one block" anti-pattern note. The chef's system prompt grew by ~50 lines but the tool catalog is still listed once (allow-list of 33 names) — full catalog is reachable through `mcp_search()`.

New `ChefEvent` kinds: `code_execute_start` and `code_execute_end`. Inner `tool_call_start`/`tool_call_result` events for every `mcp(...)` invocation are interleaved between them so the existing client renders progress unchanged.

## Tests + live verification

- **u112 — code-mode runtime** (61 assertions): searchTools, executeCode happy paths, allow-list, max_tool_calls, timeout, ensureRequired, parseCodeBlocks, buildExecuteResultBlock, truncateResult.
- **u113 — chef route Code Mode integration** (33 assertions): single block, chained calls, disallowed tool surfaces tool_call_error, legacy `[[TOOL_CALL]]` regression, mixed-turn handling.
- **u117 — JS-subset interpreter** (34 assertions): the Workers fallback path Claude actually hits in production.
- All 136 worker tests pass; `wrangler --dry-run` clean; new files TS-clean.

**Live curl** against `https://mise-graph.9f745064e644311ed09914b9a12e9c7380ce62b7.workers.dev/agent/chef` with body `{"household_id":"hh_corey_experialstudio_com","message":"plan a vegetarian dinner for tonight"}` returned an SSE stream with **6 `[[CODE]]` blocks across 4 iterations**, real `plan_create` + `plan_compose_meal` + `plan_replace_meal` + `plan_score_coherence` calls visible in the trace, and a final saved Spring Pea & Lemon Risotto on `2026-05-07 dinner`. No hallucinated saves.

## Token-cost reduction

The chef no longer needs the 33-tool allow-list embedded with descriptions in every system prompt. With Code Mode, two meta-tools (`mcp_search`, `mcp_execute`) plus a worked-example block fit in ~3 KB. The full ~60-tool catalog (and any future tools added to `PLAN_WORLD_TOOLS`) is reachable without re-prompting. Per-turn savings ≈ 4–5 K tokens; per-deep-conversation savings compound.
