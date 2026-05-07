-- Active plan persistence used by the PlanWorld MCP server.
--
-- Plans live here while an agent is composing them turn-by-turn via
-- /mcp/plan-world tool calls. Each row is a snapshot of a MiseWeeklyPlanDraft
-- as JSON; tools load the row, mutate the in-memory plan, and INSERT OR
-- REPLACE it back. Distinct from `mise_week_plans` (which is the canonical
-- archive used by the deterministic planner) so the agent loop has its own
-- working set without colliding with archival behavior.

CREATE TABLE IF NOT EXISTS mise_active_plans (
    plan_id     TEXT PRIMARY KEY,
    household_id TEXT,
    plan_json   TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'draft',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mise_active_plans_household
    ON mise_active_plans (household_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_mise_active_plans_status
    ON mise_active_plans (status, updated_at DESC);
