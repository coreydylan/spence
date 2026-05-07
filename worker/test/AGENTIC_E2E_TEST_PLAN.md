# Agentic Planner E2E Test Plan

The current suite proves narrow mechanics: critics fire, previews mutate, and the legacy pipeline runs. It does not prove that a whole plan is globally coherent or that an agent has enough state to avoid calendar-level mistakes. This plan defines the missing test contract for the PlanWorld direction.

## Principles

- Fast tests are deterministic and use synthetic plans. No LLM, DB, network, or Cloudflare runtime.
- Every e2e test starts from a plan with failures we have seen in real output: impossible lead times, duplicate meals, leftover fiction, redundant prep, placeholder meals, and hidden global incoherence.
- Tests assert agent-facing observability first. If a tool cannot show the issue clearly, an agent cannot fix it reliably.
- Live tests are acceptance tests only. They should be few, explicit, and run with `--tier=live`.

## Fast Suite

### `u16` Coherence Score

Purpose: a deterministic acceptance metric catches issues critics do not yet model.

Invariants:
- exact or normalized duplicate meal titles score as issues
- same-day cuisine/format repetition scores as issues
- missing cuisine and unknown format score as issues
- malformed or reverse-time leftover claims score as issues
- redundant prep batches within quality window score as issues
- hard critic and dependency-edge violations are included in the score
- a coherent control plan scores zero or near-zero

### `u17` Plan Map Renderer

Purpose: one read gives an agent enough global context to reason about the whole calendar.

Invariants:
- markdown contains window status, calendar grid, batches, prep, shopping, edges, grievances, and proposals
- violated/critical dependency edges are visible by title/id and rule kind
- shelf-life/dietary/leftover grievances are grouped by severity
- compact mode is readable and bounded
- full mode appends machine-readable JSON fences

### `t13` Broken Plan Regression

Purpose: fixture-level test for the exact class of plans that looked good in snapshots but failed human audit.

Fixture shape:
- 7 or 14 days
- Mon dinner uses 48h dough prepped same day
- Tue lunch is a future dinner leftover
- same-day duplicate cuisine/title appears at least once
- redundant hummus or sauce prep appears within its shelf window
- snack/breakfast placeholders with missing cuisine/format

Invariants:
- legacy hard critics alone do not need to catch every issue
- coherence score must be bad
- plan map must expose the bad reasons in one call

### `t14` PlanWorld Tool Loop

Purpose: prove an agent can read, preview, commit, and finalize without relying on hidden state.

Invariants:
- `planReadSummary` reports initial hard/coherence issues
- `planReadMap` or summary exposes the next best fix target
- previewing a mutation returns deltas and score/grievance movement
- committing changes the world state
- finalizing returns fewer hard/coherence issues
- proposal ids are one-shot and unknown ids fail cleanly

### `t15` Empty-Slot Chronological Composition Contract

Purpose: prevent a future agent harness from composing blind or out of order.

Invariants:
- empty slots are returned chronologically
- slot reads include recent meals, same-day meals, planned leftovers, and available batches
- composing/replacing a slot updates subsequent reads
- future leftovers cannot feed earlier lunches

### `t16` Agentic Final Acceptance Without LLM

Purpose: scripted mock agent completes a small plan using only tools.

Invariants:
- script fills or repairs a 3- to 7-day window
- every turn reads state before writing
- no hard grievances at finalize
- coherence score below threshold
- final map shows no duplicate/placeholder/lead-time failures

## Protocol Suite

### `u18` MCP JSON-RPC Tool Contract

Purpose: protocol wrapper stays thin and stable.

Invariants:
- initialize/list-tools returns expected PlanWorld tools
- invalid method/params return JSON-RPC errors
- read tool result shape matches pure tool core
- write tool result includes preview, commit metadata, and final state id

### `t17` Persisted Tool State

Purpose: prove Worker route state survives separate calls.

Invariants:
- create/load plan writes to `mise_week_plans`
- preview call does not mutate persisted plan
- commit call persists updated `plan_json`
- subsequent read sees committed state

## Live Suite

### `l01` Live Agent 7-Day Dinners

Purpose: acceptance test for the real bridge/model loop.

Invariants:
- final plan has zero hard grievances
- coherence score below threshold
- every dinner has cuisine, format, method, and real ingredients/components
- no impossible lead-time edges
- no same-day duplicate title/cuisine/format
- leftovers only flow forward

### `l02` Live Repair Existing Broken Plan

Purpose: acceptance test for practical recovery, not just greenfield planning.

Invariants:
- starts from `t13` broken fixture or a production snapshot
- agent reads map before first write
- agent commits at least two structural fixes
- hard/coherence issues decrease monotonically or with justified temporary regressions
- final map is human-auditable

## Rollout Order

1. Implement `u16`, `u17`, `t14`.
2. Add `t13` fixture regression once coherence/map APIs exist.
3. Add pure PlanWorld loop coverage before MCP protocol.
4. Add MCP route and persisted-state tests.
5. Only then enable live bridge acceptance tests.
