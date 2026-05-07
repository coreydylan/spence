-- PlanAgent embedded SQLite schema (Wave 7 foundation).
--
-- One DO per active plan. Holds plan_id + dispatch state + spawn ledger of
-- the meal/shop/cook agents this plan owns. Wave 7B will fill in:
--   * critic invocations + outcomes
--   * coherence-score history
--   * commit attempts (preview → commit pipeline)

CREATE TABLE IF NOT EXISTS spawned_children (
  child_kind TEXT NOT NULL,       -- 'meal' | 'shop' | 'cook'
  child_name TEXT NOT NULL,       -- the DO name (matches mealAgentName(...) etc.)
  spawned_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL,           -- 'spawned' | 'archived'
  PRIMARY KEY (child_kind, child_name)
);

CREATE INDEX IF NOT EXISTS idx_plan_children_kind
    ON spawned_children(child_kind, spawned_at_ms DESC);

CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  at_ms INTEGER NOT NULL,
  action TEXT NOT NULL,           -- 'create' | 'finalize' | 'archive' | ...
  payload_json TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 1,
  error TEXT
);
