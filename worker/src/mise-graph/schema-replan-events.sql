-- Audit log for replan webhook events.
--
-- One row per ReplanEvent that was either applied or attempted. Lets the UI /
-- agent reconstruct "what changed since I last looked" without re-running the
-- whole critic loop. Intended companion to mise_active_plans — the plan_json
-- holds current state, this table holds the deltas that produced it.

CREATE TABLE IF NOT EXISTS mise_replan_events (
    event_id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    event_kind TEXT NOT NULL,
    event_json TEXT NOT NULL,
    applied INTEGER NOT NULL,
    applied_at TEXT NOT NULL,
    ripple_summary_json TEXT,
    human_summary TEXT
);

CREATE INDEX IF NOT EXISTS idx_replan_plan
    ON mise_replan_events (plan_id, applied_at DESC);
