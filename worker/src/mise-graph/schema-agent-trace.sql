-- Agent trace + replay debug layer (Wave 6).
--
-- Every PlanWorld MCP tool call writes a row into mise_agent_traces capturing
-- the call's args, result (truncated), duration, and outcome. WRITE tools
-- additionally write rows into mise_mutation_traces linking the produced
-- mutation_id (meal_id, batch_id, etc.) back to the trace_id so the question
-- "why did Spence pick pizza Saturday?" can be answered by walking the trace
-- chain that ended in that meal.
--
-- Companion module: src/mise-graph/agent-trace.ts. Each handler in
-- plan-world-mcp.ts wraps its body in `traced()` from that module — the
-- trace_id is generated before the tool runs and persisted on completion
-- (success or failure). Failures are recorded with ok=0 + error so we still
-- see what the agent attempted, not just what succeeded.

CREATE TABLE IF NOT EXISTS mise_agent_traces (
  trace_id TEXT PRIMARY KEY,
  household_id TEXT,
  plan_id TEXT,
  parent_trace_id TEXT,           -- for nested calls (subagent / cascade)

  tool_name TEXT NOT NULL,
  tool_args_json TEXT NOT NULL,
  tool_result_json TEXT,           -- full or truncated result
  result_summary TEXT,             -- short human-readable summary

  caller_kind TEXT NOT NULL,       -- 'agent'|'human'|'system'|'cron'|'replan'|'subagent'
  caller_id TEXT,                  -- session id, agent id, or null

  duration_ms INTEGER NOT NULL,
  ok INTEGER NOT NULL DEFAULT 1,
  error TEXT,

  triggered_mutations_json TEXT,   -- JSON array of {kind, mutation_id} this call committed

  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_traces_plan
    ON mise_agent_traces(plan_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_traces_parent
    ON mise_agent_traces(parent_trace_id);

-- Mutation → trace linkage. Every committed mutation references the trace
-- that produced it. Allows reverse lookup: "what was the agent thinking
-- when this meal got committed?" via getMutationTrace().
CREATE TABLE IF NOT EXISTS mise_mutation_traces (
  mutation_id TEXT PRIMARY KEY,    -- meal_id, batch_id, prep_task_id, shop_run_id, etc.
  mutation_kind TEXT NOT NULL,     -- 'compose_meal'|'split_batch'|'move_shop'|...
  plan_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  committed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mutation_traces_plan
    ON mise_mutation_traces(plan_id, committed_at DESC);

CREATE INDEX IF NOT EXISTS idx_mutation_traces_trace
    ON mise_mutation_traces(trace_id);
