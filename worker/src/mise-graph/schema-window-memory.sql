-- Window-memory & feedback schema (additive).
--
-- This file is applied separately from schema.sql so it can be deployed to
-- remote D1 without touching the main schema migration. window-memory.ts
-- only READS existing tables (mise_week_plans), so the only new table here
-- is `mise_meal_feedback` for the taste-rating loop in recipe-feedback.ts.

CREATE TABLE IF NOT EXISTS mise_meal_feedback (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  plan_id TEXT REFERENCES mise_week_plans(id) ON DELETE CASCADE,
  meal_id TEXT NOT NULL,
  meal_date TEXT,
  meal_slot TEXT,
  meal_title TEXT,
  meal_cuisine_json TEXT DEFAULT '[]',
  meal_format TEXT,
  rating INTEGER,                           -- 1-5
  would_repeat INTEGER,                     -- 1 = yes, 0 = no
  finished INTEGER,                         -- 1 = ate it all, 0 = leftover/wasted
  notes TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  meta_json TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_mise_meal_feedback_household
  ON mise_meal_feedback(household_id, recorded_at);

CREATE INDEX IF NOT EXISTS idx_mise_meal_feedback_plan
  ON mise_meal_feedback(plan_id);
