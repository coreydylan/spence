-- ShopAgent embedded SQLite schema (Wave 7 foundation).
--
-- One DO per shop run. Owns the run's phase state machine
-- (planned → active_today → completed). Wave 7B extends with:
--   * shopping list snapshot (resolved from plan-world ledger at commit)
--   * checkoff progress (item id → bought_at_ms)
--   * receipt photos / OCR results

CREATE TABLE IF NOT EXISTS phase_transitions (
  id TEXT PRIMARY KEY,
  from_phase TEXT NOT NULL,
  to_phase TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_shop_phase_at
    ON phase_transitions(at_ms ASC);
