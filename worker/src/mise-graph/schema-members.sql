-- Per-person HouseholdMember schema (Wave 6).
--
-- This breaks "household = single bag" apart into individuals so the
-- planner / brigade scheduler can reason about each member's dietary
-- constraints, preferences, skills, safety, and presence in the kitchen.
--
-- Relationship to existing tables:
--   * mise_household_profiles still holds household-wide defaults (people_count,
--     dietary, equipment) — members add per-person overrides on top of that.
--   * Each member's skills live in a separate row-per-skill table so we can
--     recompute confidence cheaply and keep an append-only history log.
--   * Presence is a singleton per member (current kitchen state); brigade
--     mode (Wave 8) reads from it to find idle workers.
--
-- All tables namespaced `mise_*`, idempotent (`CREATE TABLE IF NOT EXISTS`).

CREATE TABLE IF NOT EXISTS mise_household_members (
  member_id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  age_group TEXT NOT NULL DEFAULT 'adult',          -- 'adult'|'teen'|'kid'|'toddler'
  dietary_json TEXT NOT NULL DEFAULT '[]',          -- per-person dietary tags
  preferences_json TEXT NOT NULL DEFAULT '{}',      -- {loves, dislikes, allergies}
  safety_json TEXT NOT NULL DEFAULT '{}',           -- MemberSafety
  active_skill_quests_json TEXT DEFAULT '[]',       -- ["learn_dough_basic", ...]
  privacy_json TEXT NOT NULL DEFAULT '{}',          -- {share_skills_with_household, share_tastes_with_household}
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_members_household
  ON mise_household_members(household_id);

CREATE TABLE IF NOT EXISTS mise_member_skills (
  member_id TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,               -- 0..1
  tasks_completed INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  speed_multiplier REAL NOT NULL DEFAULT 1.0,
  notes TEXT,
  PRIMARY KEY (member_id, skill_name)
);

CREATE TABLE IF NOT EXISTS mise_member_skill_history (
  history_id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  task_id TEXT,
  meal_id TEXT,
  outcome TEXT NOT NULL,                            -- 'success'|'partial'|'failure'|'retry'
  duration_actual_min REAL,
  duration_expected_min REAL,
  user_rating INTEGER,                              -- 1..5 if user gave feedback
  notes TEXT,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skill_history_member
  ON mise_member_skill_history(member_id, skill_name, recorded_at DESC);

CREATE TABLE IF NOT EXISTS mise_member_presence (
  member_id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'absent',             -- 'absent'|'in_kitchen_idle'|'busy_assigned'|'stepped_away'
  current_task_id TEXT,
  current_session_id TEXT,
  last_ping_at TEXT,
  websocket_open INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
