-- CookAgent embedded SQLite schema (Wave 7 foundation).
--
-- One DO per cook session — distinct from MealAgent. CookAgent is the
-- runtime that pilots a single brigade through prep → cook → service. In
-- Wave 8 it becomes ephemeral and spawns a CookingLeadAgent per session;
-- Wave 7 keeps it as a long-lived DO with the state machine
-- planned → pre_session → active_session → completed.
--
-- Wave 7B extensions:
--   * task assignments (member_id → task_id, with start_at/finish_at)
--   * equipment ledger snapshot
--   * photo capture log

CREATE TABLE IF NOT EXISTS phase_transitions (
  id TEXT PRIMARY KEY,
  from_phase TEXT NOT NULL,
  to_phase TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_cook_phase_at
    ON phase_transitions(at_ms ASC);
