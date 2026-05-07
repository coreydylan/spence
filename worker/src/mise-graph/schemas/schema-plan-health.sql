-- Wave 7B Track B — PlanAgent nightly recompute cache.
--
-- The PlanAgent DO recomputes a plan's coherence score + grievance summary
-- on a daily alarm and stores the latest snapshot here. Other surfaces
-- (HouseholdAgent daily brief, replay UI) read from this table rather than
-- re-running the whole critic pipeline.
--
-- One row per (plan_id, recorded_on); we keep history rather than overwrite
-- so the trend is auditable.
--
-- Idempotent: safe to apply on every deploy.

CREATE TABLE IF NOT EXISTS mise_plan_health (
    id TEXT PRIMARY KEY,                    -- ulid-ish
    plan_id TEXT NOT NULL,
    household_id TEXT,
    recorded_on TEXT NOT NULL,              -- YYYY-MM-DD when the snapshot was taken
    coherence_score REAL,                   -- 0..1 snapshot
    hard_grievance_count INTEGER NOT NULL DEFAULT 0,
    warning_grievance_count INTEGER NOT NULL DEFAULT 0,
    issue_summary_json TEXT,                -- compact list of headline issues
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_health_unique
    ON mise_plan_health(plan_id, recorded_on);

CREATE INDEX IF NOT EXISTS idx_plan_health_plan_recent
    ON mise_plan_health(plan_id, created_at_ms DESC);
