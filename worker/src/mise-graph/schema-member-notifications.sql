-- Member notifications (Wave 7B Track A).
--
-- MealAgent.cook_window_entry writes a `member_call` notification per adult
-- member when the cook window opens. Wave 8 will spawn a CookingLeadAgent
-- that subscribes to this table and pushes the notification to each
-- member's phone via the live cooking surface; for Wave 7 we just persist
-- the row and let the parent PlanAgent emit a state event.
--
-- `kind` values are open-ended so other agents (HouseholdAgent's daily
-- check-in, CookAgent's prep alarms, etc.) can append rows here too.

CREATE TABLE IF NOT EXISTS mise_member_notifications (
  notification_id TEXT PRIMARY KEY,
  household_id TEXT,
  member_id TEXT NOT NULL,
  source_agent_kind TEXT NOT NULL,           -- 'meal_agent' | 'cook_agent' | ...
  source_agent_id TEXT NOT NULL,             -- meal_id / cook_session_id
  kind TEXT NOT NULL,                        -- 'member_call' | 'reminder' | ...
  title TEXT NOT NULL,
  body TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL,
  acknowledged_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_member_notif_member
  ON mise_member_notifications(member_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_member_notif_source
  ON mise_member_notifications(source_agent_kind, source_agent_id);
