-- Cook-session marker rows (Wave 7B Track A).
--
-- MealAgent.active_cook_entry writes a row here when a cook session
-- starts. Wave 8 expands this into the CookingLeadAgent — until then the
-- row exists as a "Wave 8 expansion point" so the parent PlanAgent can
-- enumerate live cook sessions across all its meals without poking each
-- MealAgent's embedded SQLite.
--
-- The `state` column lifecycle is:
--   started  → MealAgent.active_cook_entry inserts the row.
--   stale    → 4h timeout marker (still active_cook on the meal).
--   ended    → MealAgent.eaten_entry / cancelled_entry mark complete.

CREATE TABLE IF NOT EXISTS mise_cook_sessions (
  cook_session_id TEXT PRIMARY KEY,
  household_id TEXT,
  plan_id TEXT,
  meal_id TEXT NOT NULL,
  state TEXT NOT NULL,                       -- 'started' | 'stale' | 'ended'
  started_at TEXT NOT NULL,
  stale_at TEXT,
  ended_at TEXT,
  ended_reason TEXT,
  meta_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_cook_sessions_meal
  ON mise_cook_sessions(meal_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_cook_sessions_plan
  ON mise_cook_sessions(plan_id, started_at DESC);
