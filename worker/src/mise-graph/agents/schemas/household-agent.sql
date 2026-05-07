-- HouseholdAgent embedded SQLite schema (Wave 7 foundation).
--
-- Each HouseholdAgent DO carries its own SQLite database (managed by the
-- Cloudflare Agents SDK via this.sql). This file documents the canonical
-- shape so Wave 7B can extend it without forking. The DO calls
-- applyHouseholdAgentSchema() in onStart() — all CREATEs are
-- IF NOT EXISTS so first-wake is idempotent.
--
-- The HouseholdAgent does NOT track phases (it's long-lived, not a state
-- machine). Instead it records:
--   * the most-recent decision log (what it dispatched, why)
--   * a counter of daily check-ins fired so we can prove the alarm runs
--
-- Wave 7B should ADD here, not replace:
--   - learnings table (anchor pressure overrides, taste shifts)
--   - movement memory (which weeks had which themes)
--   - calendar/weather snapshot cache (reduces D1 round-trips on alarm)

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  at_ms INTEGER NOT NULL,
  kind TEXT NOT NULL,             -- 'spawn_plan' | 'daily_checkin' | ...
  payload_json TEXT NOT NULL,     -- arbitrary
  trace_id TEXT                   -- link to mise_agent_traces if available
);

CREATE INDEX IF NOT EXISTS idx_household_decisions_at
    ON decisions(at_ms DESC);

CREATE TABLE IF NOT EXISTS checkins (
  id TEXT PRIMARY KEY,
  at_ms INTEGER NOT NULL,
  result TEXT                     -- 'ok' | 'skipped' | 'error: ...'
);
