-- MealAgent embedded SQLite schema.
--
-- One DO per meal. The phase field lives in DO state (auto-persisted via
-- setState). Phase changes are audited into phase_transitions — that table
-- lives in agents/base.ts so the shape is shared with ShopAgent + CookAgent.
--
-- Wave 7B Track A added:
--   * meal_snapshot — 1-row cache of the D1 meal record at /init time so
--     subsequent phase handlers don't have to re-load the plan JSON.
--   * cook_session_marker — local marker for the active cook session
--     (mirrors the row written into D1.mise_cook_sessions).
--   * mise_equipment_claims_stub — Wave 7B-C will replace; managed by
--     equipment-stub.ts.

-- Audit log. Schema mirrors agents/base.ts ensurePhaseTransitionsTable so
-- listPhaseTransitions(this) keeps working uniformly across MealAgent /
-- ShopAgent / CookAgent.
CREATE TABLE IF NOT EXISTS phase_transitions (
  id TEXT PRIMARY KEY,
  from_phase TEXT NOT NULL,
  to_phase TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_meal_phase_at
    ON phase_transitions(at_ms ASC);

-- Snapshot of the meal record loaded from D1 mise_active_plans on /init.
-- Cached locally so per-phase handlers can derive cook_window/eat_window
-- timestamps without re-reading the full plan JSON every alarm.
CREATE TABLE IF NOT EXISTS meal_snapshot (
  snapshot_id TEXT PRIMARY KEY,
  meal_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  date TEXT NOT NULL,
  slot TEXT NOT NULL,
  format TEXT,
  cuisine_json TEXT,
  recipe_id TEXT,
  cook_window_start_ms INTEGER NOT NULL,
  cook_window_end_ms INTEGER NOT NULL,
  eat_window_start_ms INTEGER NOT NULL,
  eat_window_end_ms INTEGER NOT NULL,
  equipment_json TEXT,
  source_json TEXT,
  loaded_at_ms INTEGER NOT NULL
);

-- Local marker row for an active cook session. Mirrors D1.mise_cook_sessions
-- so the DO can answer "are you cooking?" without touching D1.
CREATE TABLE IF NOT EXISTS cook_session_marker (
  cook_session_id TEXT PRIMARY KEY,
  meal_id TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  stale_at_ms INTEGER,
  ended_at_ms INTEGER,
  ended_reason TEXT
);

-- Per-DO equipment-claim ledger. Wave 7B-C will replace with real tracker.
CREATE TABLE IF NOT EXISTS mise_equipment_claims_stub (
  claim_id TEXT PRIMARY KEY,
  meal_id TEXT NOT NULL,
  equipment TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  claimed_at_ms INTEGER NOT NULL,
  released_at_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_equip_meal
    ON mise_equipment_claims_stub(meal_id);
