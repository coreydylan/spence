-- Household-memory schema (additive).
--
-- These tables back the persistent household-memory layer used by Spence's
-- chef-of-staff agent — the cross-session context that turns a meal-planner
-- into something that remembers what your household actually cooks, what
-- they keep on hand, and where the agent left off in conversation.
--
-- All tables are namespaced with `mise_` to live alongside the existing
-- mise_* / mise_meal_feedback tables. Migrations are idempotent
-- (CREATE TABLE IF NOT EXISTS) and can be applied multiple times safely.

-- Household profile: durable identity for the household.
CREATE TABLE IF NOT EXISTS mise_household_profiles (
  household_id TEXT PRIMARY KEY,
  display_name TEXT,
  people_count INTEGER NOT NULL DEFAULT 2,
  dietary_json TEXT NOT NULL DEFAULT '[]',
  equipment_json TEXT NOT NULL DEFAULT '[]',
  current_anchors_json TEXT NOT NULL DEFAULT '[]',
  cuisine_preferences_json TEXT NOT NULL DEFAULT '{}',  -- {cuisine: weight}
  default_pantry_json TEXT NOT NULL DEFAULT '[]',
  shop_preferences_json TEXT,                            -- HouseholdShopPreferences
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Conversation threads: agent's multi-turn context across requests.
CREATE TABLE IF NOT EXISTS mise_conversation_threads (
  thread_id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  topic TEXT,                                           -- "weekly_planning", "recipe_capture", "leftover_advice", etc.
  state_json TEXT NOT NULL DEFAULT '{}',                -- agent's working memory for the thread
  active_plan_id TEXT,                                  -- if the thread is operating on a plan
  last_turn_at TEXT NOT NULL,
  closed_at TEXT,
  message_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_threads_household
  ON mise_conversation_threads(household_id, last_turn_at DESC);

-- Kitchen inventory: long-term pantry/fridge stock the household keeps on hand.
-- This is DIFFERENT from a plan's pantry list — this is the persistent state of
-- "what's in the kitchen right now," updated by receipt scans, observations, etc.
CREATE TABLE IF NOT EXISTS mise_kitchen_inventory (
  inventory_id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  qty REAL,
  unit TEXT,
  storage TEXT,                                         -- 'pantry'|'fridge'|'freezer'|'counter'
  acquired_at TEXT,
  expires_at TEXT,
  source TEXT,                                          -- 'shop_run'|'observation'|'recipe_input_residual'
  consumed BOOLEAN DEFAULT FALSE,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inventory_household
  ON mise_kitchen_inventory(household_id, expires_at);

-- Anchor evolution: tracks how the household's anchor ingredients change over time
-- based on what they actually cook (not just what was planned).
CREATE TABLE IF NOT EXISTS mise_anchor_evolution (
  household_id TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  pressure REAL NOT NULL,                               -- 0..1; computed from recent_use / window
  trend TEXT,                                           -- 'rising'|'falling'|'stable'|'saturated'
  PRIMARY KEY (household_id, canonical_name, recorded_at)
);

-- Meal history: append-only log of what the household actually cooked.
-- Distinct from mise_meal_feedback (which is a rating); this is the
-- ground-truth event stream used to compute anchor evolution + cuisine
-- preferences. recordCookedMeal() writes here.
CREATE TABLE IF NOT EXISTS mise_meal_history (
  meal_history_id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  cooked_on TEXT NOT NULL,                              -- 'YYYY-MM-DD' (the meal date)
  slot TEXT,                                            -- 'breakfast'|'lunch'|'dinner'|'snack'
  title TEXT,
  cuisine_json TEXT NOT NULL DEFAULT '[]',
  format TEXT,
  anchors_json TEXT NOT NULL DEFAULT '[]',
  recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_meal_history_household
  ON mise_meal_history(household_id, cooked_on DESC);
