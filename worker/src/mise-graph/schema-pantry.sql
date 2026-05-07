-- Mise pantry — household pantry/fridge/freezer lots.
--
-- Additive schema for real pantry tracking with expiration awareness.
-- Each row is one "lot" of a thing in the household: a jar of tahini, a bag of
-- rice, a bunch of cilantro. Lots can have an open date (perishables decay
-- faster once opened), a best_until / safe_until window, and optional
-- quantity / unit / grams to inform composition + shopping.
--
-- Loaded by pantry-pressure.ts via loadPantryPressure(env, household_id, dates)
-- and surfaced to the menu composer LLM as a context bundle alongside the
-- canonical-dish / affinity / seasonal context.

CREATE TABLE IF NOT EXISTS mise_pantry_lots (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  storage_location TEXT DEFAULT 'pantry',
  quantity REAL,
  unit TEXT,
  grams REAL,
  opened_at TEXT,
  best_until TEXT,
  safe_until TEXT,
  notes TEXT,
  meta_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_mise_pantry_lots_household
  ON mise_pantry_lots(household_id);

CREATE INDEX IF NOT EXISTS idx_mise_pantry_lots_expiry
  ON mise_pantry_lots(household_id, best_until);

CREATE INDEX IF NOT EXISTS idx_mise_pantry_lots_canonical
  ON mise_pantry_lots(household_id, canonical_name);
