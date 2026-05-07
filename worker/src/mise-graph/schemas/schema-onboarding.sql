-- Onboarding (Phase A) — progressive depth-tiered question/answer state per
-- household, plus the 7-dimension trait inference store and a forward
-- declaration for traditions (used by Phase B).
--
-- See ONBOARDING_DESIGN.md for the design tenets. Phase A creates the
-- tables + ALTERs three new columns onto mise_household_profiles.

-- ---------------------------------------------------------------------------
-- Tier state machine: one row per household.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mise_onboarding_state (
	household_id TEXT PRIMARY KEY,
	current_tier INTEGER NOT NULL DEFAULT 0,
	tier_0_completed_at TEXT,
	tier_1_completed_at TEXT,
	tier_2_completed_at TEXT,
	tier_3_completed_at TEXT,
	active_question_bag_json TEXT,        -- queued questions waiting for a slot
	engagement_signal REAL NOT NULL DEFAULT 1.0,
	last_question_asked_at TEXT,
	questions_asked_count INTEGER NOT NULL DEFAULT 0,
	questions_answered_count INTEGER NOT NULL DEFAULT 0,
	questions_skipped_count INTEGER NOT NULL DEFAULT 0,
	updated_at_ms INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Append-only log of every question asked and every response (or skip).
-- response_text IS NULL means the user skipped.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mise_onboarding_responses (
	response_id TEXT PRIMARY KEY,
	household_id TEXT NOT NULL,
	member_id TEXT,
	question_kind TEXT NOT NULL,
	question_text TEXT NOT NULL,
	response_text TEXT,
	response_chars INTEGER NOT NULL DEFAULT 0,
	asked_at_ms INTEGER NOT NULL,
	answered_at_ms INTEGER,
	inferred_traits_json TEXT,
	tier INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_onboarding_responses_household
	ON mise_onboarding_responses(household_id, asked_at_ms DESC);

-- ---------------------------------------------------------------------------
-- Derived personality dimensions per household. 7 trait names enumerated in
-- onboarding-questions.ts. Optional member_id column exists but is unused in
-- Phase A — leave NULL to track at household granularity.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mise_household_traits (
	household_id TEXT NOT NULL,
	trait_name TEXT NOT NULL,
	member_id TEXT,
	trait_value REAL NOT NULL DEFAULT 0.5,
	confidence REAL NOT NULL DEFAULT 0,
	last_evidence_at_ms INTEGER NOT NULL,
	evidence_count INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (household_id, trait_name)
);

-- ---------------------------------------------------------------------------
-- Standing meals / cadence-bound rituals (Friday pizza, Sunday roast, ...).
-- Phase A creates the table; Phase B ships the MCP tools that read/write it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mise_household_traditions (
	tradition_id TEXT PRIMARY KEY,
	household_id TEXT NOT NULL,
	name TEXT NOT NULL,
	cadence TEXT NOT NULL,
	description TEXT,
	must_include_ingredients_json TEXT,
	must_include_format TEXT,
	origin_note TEXT,
	active INTEGER NOT NULL DEFAULT 1,
	created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_traditions_household
	ON mise_household_traditions(household_id, active);

-- ---------------------------------------------------------------------------
-- Three new columns on the existing household profile. Use ALTER TABLE in
-- migrations.ts wrapped with try/catch so re-runs are idempotent (D1 raises
-- "duplicate column name" on second apply).
-- ---------------------------------------------------------------------------
-- ALTER TABLE mise_household_profiles ADD COLUMN dinner_ritual TEXT;
-- ALTER TABLE mise_household_profiles ADD COLUMN cook_frequency TEXT;
-- ALTER TABLE mise_household_profiles ADD COLUMN pantry_intake_mode TEXT;
