-- Meal-briefing rows written by MealAgent's per-phase entry handlers
-- (Wave 7B Track A).
--
-- Three "kinds" of briefing co-exist in this single table — keyed by
-- `kind`:
--   * pre_eve: written 24h before eat_window, summarises tomorrow's meal.
--   * day_of:  written morning-of, includes presence + missed-prep flags.
--   * cook_window: written when cook_window opens, includes weather snapshot
--                  + equipment claim status + member call notifications.
--
-- We collapse them into one table so PlanAgent / HouseholdAgent can scroll
-- the most recent N briefings for a household without three separate
-- queries. The `payload_json` field carries the kind-specific content.

CREATE TABLE IF NOT EXISTS mise_meal_briefings (
  briefing_id TEXT PRIMARY KEY,
  household_id TEXT,
  plan_id TEXT,
  meal_id TEXT NOT NULL,
  kind TEXT NOT NULL,                       -- 'pre_eve' | 'day_of' | 'cook_window'
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_meal_briefings_meal
  ON mise_meal_briefings(meal_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_meal_briefings_household
  ON mise_meal_briefings(household_id, created_at DESC);
