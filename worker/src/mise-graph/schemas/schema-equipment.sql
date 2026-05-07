-- Equipment resource tracking — Wave 7B Track C.
--
-- Kitchens have limited resources: one oven, four burners, one stand mixer,
-- finite counter space. When a meal claims an oven for 90 minutes between
-- 17:30 and 19:00, no other meal/task can claim that same oven in that
-- window. The equipment claim table is the canonical lock ledger.
--
-- Conflict semantics are interval-overlap based: two claims conflict when
-- start < other.end AND end > other.start. For exclusive equipment, ANY
-- overlap is a conflict. For shared equipment with capacity N (e.g. four
-- burners on the same range), overlap is only a conflict when the active
-- claim count equals or exceeds N.
--
-- The partial index `ix_equip_claims_slug_window` is the hot path: given a
-- slug and a window, find all currently held claims that touch the window.

CREATE TABLE IF NOT EXISTS mise_equipment_definitions (
  slug TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  household_id TEXT NOT NULL,
  exclusive INTEGER NOT NULL,
  capacity INTEGER,
  notes TEXT,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_equip_def_household
  ON mise_equipment_definitions(household_id);

CREATE TABLE IF NOT EXISTS mise_equipment_claims (
  id TEXT PRIMARY KEY,
  equipment_slug TEXT NOT NULL,
  claim_for_kind TEXT NOT NULL,
  claim_for_id TEXT NOT NULL,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'held',
  claimed_by TEXT NOT NULL,
  released_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_equip_claims_slug_window
  ON mise_equipment_claims(equipment_slug, start_ts, end_ts) WHERE status = 'held';

CREATE INDEX IF NOT EXISTS ix_equip_claims_for
  ON mise_equipment_claims(claim_for_kind, claim_for_id) WHERE status = 'held';
