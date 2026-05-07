-- MemberAgent embedded SQLite schema (Wave 7 foundation).
--
-- One DO per household member. Wraps the existing logic in
-- src/mise-graph/household-members.ts. The CANONICAL store for member
-- profiles + skills remains the D1 tables (mise_household_members,
-- mise_member_skills, mise_member_skill_history) — Wave 7B reads/writes
-- through those, just routed via the DO.
--
-- The DO's embedded SQLite holds *fast-changing* presence + recent activity
-- that doesn't need to round-trip through D1:
--   * presence pings (live during cook)
--   * recent task outcomes (last N) — buffered before flush to D1
--
-- Wave 7B will:
--   * load the D1 profile in onStart() and cache it in DO state
--   * keep the D1 table authoritative; DO is a hot-path cache + presence

CREATE TABLE IF NOT EXISTS presence_pings (
  id TEXT PRIMARY KEY,
  at_ms INTEGER NOT NULL,
  state TEXT NOT NULL,            -- 'absent' | 'in_kitchen_idle' | 'busy_assigned' | 'stepped_away'
  source TEXT,                    -- 'manual' | 'cook-session-event' | 'phone-presence' | ...
  meta_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_member_presence_at
    ON presence_pings(at_ms DESC);

-- Recent skill outcome buffer — flushed to D1 mise_member_skill_history in
-- batches by Wave 7B. For Wave 7 foundation it just exists with the right
-- columns so the writers can land the schema migration.
CREATE TABLE IF NOT EXISTS pending_skill_outcomes (
  id TEXT PRIMARY KEY,
  at_ms INTEGER NOT NULL,
  skill_name TEXT NOT NULL,
  outcome TEXT NOT NULL,
  duration_actual_min REAL,
  duration_expected_min REAL,
  user_rating INTEGER,
  task_id TEXT,
  meal_id TEXT,
  notes TEXT,
  flushed_to_d1 INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_member_pending_outcomes
    ON pending_skill_outcomes(flushed_to_d1, at_ms ASC);
