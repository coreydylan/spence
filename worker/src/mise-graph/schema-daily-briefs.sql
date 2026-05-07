-- Daily brief schema (additive).
--
-- Each row is one "morning brief" produced by the daily check-in cron for a
-- single household + date. Wave 5F integrates this with notification surfaces
-- (push / email / read endpoint) by polling for `delivered = FALSE` rows and
-- flipping them via markBriefDelivered() in daily-brief.ts.
--
-- Idempotent — safe to apply on every deploy.

CREATE TABLE IF NOT EXISTS mise_daily_briefs (
  brief_id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  plan_id TEXT,
  for_date TEXT NOT NULL,            -- YYYY-MM-DD this brief is FOR
  generated_at TEXT NOT NULL,        -- when we ran the agent
  brief_text TEXT NOT NULL,          -- the agent's natural-language brief
  brief_meta_json TEXT,              -- structured: today's meals, expiring items, action items
  delivered BOOLEAN DEFAULT FALSE,
  delivered_at TEXT,
  delivery_channel TEXT              -- 'push'|'email'|'sms'|'read_endpoint'
);

CREATE INDEX IF NOT EXISTS idx_briefs_household_date ON mise_daily_briefs(household_id, for_date DESC);
