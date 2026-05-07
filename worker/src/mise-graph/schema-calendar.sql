-- Calendar schema (Wave 6).
--
-- Backs the weather + calendar tools that give the planning agent context
-- about household commitments and lets Spence stage cooks / shops / meals
-- onto the user's calendar.
--
-- mise_calendar_blocks: read-side. Synthetic for the demo (manual + future
-- Google/iCloud sync); serves up busy windows for cook/eat/shop derivation.
--
-- mise_staged_calendar_events: write-side. Spence-created events that live
-- here until a future OAuth-sync layer pushes them to a real calendar. The
-- agent uses status (staged|pushed|canceled) to keep the calendar coherent
-- with replans.

CREATE TABLE IF NOT EXISTS mise_calendar_blocks (
  block_id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  title TEXT NOT NULL,
  busy INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'manual',     -- 'google'|'icloud'|'manual'
  location TEXT,
  description TEXT,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_calendar_household
  ON mise_calendar_blocks(household_id, start_at);

CREATE TABLE IF NOT EXISTS mise_staged_calendar_events (
  event_id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  plan_id TEXT,
  entity_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,                 -- 'shop'|'cook'|'meal'
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  location TEXT,
  metadata_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'staged',     -- 'staged'|'pushed'|'canceled'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_staged_events_plan
  ON mise_staged_calendar_events(plan_id, status);
