// Wave 7B Track B — schema migrations for the new HouseholdAgent /
// PlanAgent / ShopAgent D1 caches.
//
// Each table has a `.sql` sibling in this directory that mirrors the schema
// for human reading + `wrangler d1 execute --file=...`. The TS `migrateXxx`
// functions are what the worker uses (idempotent CREATE TABLE IF NOT EXISTS
// statements run via env.DB.prepare) so it can apply migrations on demand
// without shipping the .sql files into the bundle. Phase 2 wires admin
// routes to call these.
//
// Pattern matches `migrateCalendarSchema` in src/mise-graph/calendar-tools.ts.

import type { MiseGraphEnv } from "../types";

interface MigrationStmt {
	table: string;
	sql: string;
}

// ─── Daily briefs (HouseholdAgent) ─────────────────────────────────────────

const DAILY_BRIEFS_MIGRATIONS: ReadonlyArray<MigrationStmt> = [
	{
		table: "mise_household_agent_briefs",
		sql: `CREATE TABLE IF NOT EXISTS mise_household_agent_briefs (
			id TEXT PRIMARY KEY,
			household_id TEXT NOT NULL,
			for_date TEXT NOT NULL,
			weather_summary_json TEXT,
			calendar_windows_json TEXT,
			plan_health_json TEXT,
			suggestions_json TEXT,
			brief_id TEXT,
			created_at_ms INTEGER NOT NULL,
			updated_at_ms INTEGER NOT NULL
		)`,
	},
	{
		table: "idx_household_agent_briefs_unique",
		sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_household_agent_briefs_unique
			ON mise_household_agent_briefs(household_id, for_date)`,
	},
	{
		table: "idx_household_agent_briefs_recent",
		sql: `CREATE INDEX IF NOT EXISTS idx_household_agent_briefs_recent
			ON mise_household_agent_briefs(household_id, created_at_ms DESC)`,
	},
];

export async function migrateDailyBriefsSchema(env: MiseGraphEnv): Promise<{ migrated: string[] }> {
	const migrated: string[] = [];
	for (const stmt of DAILY_BRIEFS_MIGRATIONS) {
		await env.DB.prepare(stmt.sql).run();
		migrated.push(stmt.table);
	}
	return { migrated };
}

// ─── Plan health (PlanAgent nightly cache) ──────────────────────────────────

const PLAN_HEALTH_MIGRATIONS: ReadonlyArray<MigrationStmt> = [
	{
		table: "mise_plan_health",
		sql: `CREATE TABLE IF NOT EXISTS mise_plan_health (
			id TEXT PRIMARY KEY,
			plan_id TEXT NOT NULL,
			household_id TEXT,
			recorded_on TEXT NOT NULL,
			coherence_score REAL,
			hard_grievance_count INTEGER NOT NULL DEFAULT 0,
			warning_grievance_count INTEGER NOT NULL DEFAULT 0,
			issue_summary_json TEXT,
			created_at_ms INTEGER NOT NULL,
			updated_at_ms INTEGER NOT NULL
		)`,
	},
	{
		table: "idx_plan_health_unique",
		sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_health_unique
			ON mise_plan_health(plan_id, recorded_on)`,
	},
	{
		table: "idx_plan_health_plan_recent",
		sql: `CREATE INDEX IF NOT EXISTS idx_plan_health_plan_recent
			ON mise_plan_health(plan_id, created_at_ms DESC)`,
	},
];

export async function migratePlanHealthSchema(env: MiseGraphEnv): Promise<{ migrated: string[] }> {
	const migrated: string[] = [];
	for (const stmt of PLAN_HEALTH_MIGRATIONS) {
		await env.DB.prepare(stmt.sql).run();
		migrated.push(stmt.table);
	}
	return { migrated };
}

// ─── Shop reminders (ShopAgent active_today fires) ─────────────────────────

const SHOP_REMINDERS_MIGRATIONS: ReadonlyArray<MigrationStmt> = [
	{
		table: "mise_shop_reminders",
		sql: `CREATE TABLE IF NOT EXISTS mise_shop_reminders (
			id TEXT PRIMARY KEY,
			shop_run_id TEXT NOT NULL,
			plan_id TEXT NOT NULL,
			run_date TEXT NOT NULL,
			fired_at_ms INTEGER NOT NULL,
			payload_json TEXT,
			delivered INTEGER NOT NULL DEFAULT 0,
			delivered_at_ms INTEGER,
			delivery_channel TEXT,
			created_at_ms INTEGER NOT NULL,
			updated_at_ms INTEGER NOT NULL
		)`,
	},
	{
		table: "idx_shop_reminders_unique",
		sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_shop_reminders_unique
			ON mise_shop_reminders(shop_run_id, run_date)`,
	},
	{
		table: "idx_shop_reminders_undelivered",
		sql: `CREATE INDEX IF NOT EXISTS idx_shop_reminders_undelivered
			ON mise_shop_reminders(delivered, fired_at_ms ASC)`,
	},
];

export async function migrateShopRemindersSchema(env: MiseGraphEnv): Promise<{ migrated: string[] }> {
	const migrated: string[] = [];
	for (const stmt of SHOP_REMINDERS_MIGRATIONS) {
		await env.DB.prepare(stmt.sql).run();
		migrated.push(stmt.table);
	}
	return { migrated };
}

// Convenience: apply all three. Phase 2 wiring agent will likely fold this
// into the existing /admin migrate route.
export async function migrateWave7bTrackBSchemas(env: MiseGraphEnv): Promise<{ migrated: string[] }> {
	const out: string[] = [];
	for (const fn of [
		migrateDailyBriefsSchema,
		migratePlanHealthSchema,
		migrateShopRemindersSchema,
	]) {
		const result = await fn(env);
		out.push(...result.migrated);
	}
	return { migrated: out };
}

// ─── Wave 8 brigade schema (CookingLeadAgent + token vault + event log) ─────
//
// Mirrors src/mise-graph/schemas/schema-brigade.sql. Idempotent.

const BRIGADE_MIGRATIONS: ReadonlyArray<MigrationStmt> = [
	{
		table: "mise_brigade_events",
		sql: `CREATE TABLE IF NOT EXISTS mise_brigade_events (
			id TEXT PRIMARY KEY,
			cook_session_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			member_id TEXT,
			payload_json TEXT,
			emitted_at_ms INTEGER NOT NULL
		)`,
	},
	{
		table: "ix_brigade_events_session",
		sql: `CREATE INDEX IF NOT EXISTS ix_brigade_events_session
			ON mise_brigade_events(cook_session_id, emitted_at_ms ASC)`,
	},
	{
		table: "ix_brigade_events_kind",
		sql: `CREATE INDEX IF NOT EXISTS ix_brigade_events_kind
			ON mise_brigade_events(kind, emitted_at_ms DESC)`,
	},
	{
		table: "mise_brigade_pending_tokens",
		sql: `CREATE TABLE IF NOT EXISTS mise_brigade_pending_tokens (
			token TEXT PRIMARY KEY,
			cook_session_id TEXT NOT NULL,
			member_id TEXT NOT NULL,
			expires_at_ms INTEGER NOT NULL,
			consumed_at_ms INTEGER,
			created_at_ms INTEGER NOT NULL
		)`,
	},
	{
		table: "ix_brigade_tokens_session",
		sql: `CREATE INDEX IF NOT EXISTS ix_brigade_tokens_session
			ON mise_brigade_pending_tokens(cook_session_id, created_at_ms DESC)`,
	},
	{
		// SQLite supports partial indexes (WHERE clause). D1 follows SQLite.
		table: "ix_brigade_tokens_unconsumed",
		sql: `CREATE INDEX IF NOT EXISTS ix_brigade_tokens_unconsumed
			ON mise_brigade_pending_tokens(member_id, expires_at_ms DESC)
			WHERE consumed_at_ms IS NULL`,
	},
];

export async function migrateBrigadeSchema(env: MiseGraphEnv): Promise<{ migrated: string[] }> {
	const migrated: string[] = [];
	for (const stmt of BRIGADE_MIGRATIONS) {
		await env.DB.prepare(stmt.sql).run();
		migrated.push(stmt.table);
	}
	return { migrated };
}

// ─── Onboarding schema (Phase A — tiers 0/1) ───────────────────────────────
//
// Mirrors src/mise-graph/schemas/schema-onboarding.sql. Idempotent.
//   * mise_onboarding_state — one row per household, current tier + counters
//   * mise_onboarding_responses — append-only Q/A log; skips have NULL
//     response_text
//   * mise_household_traits — 7-dimension personality cache (member_id is
//     reserved for future per-member tracking; Phase A leaves it NULL)
//   * mise_household_traditions — Phase B feature; table exists but tools
//     don't read/write it yet
//
// The three new columns on mise_household_profiles (dinner_ritual,
// cook_frequency, pantry_intake_mode) ride on ALTER TABLE statements wrapped
// in try/catch so re-applying is a no-op when the column already exists.

const ONBOARDING_MIGRATIONS: ReadonlyArray<MigrationStmt> = [
	{
		table: "mise_onboarding_state",
		sql: `CREATE TABLE IF NOT EXISTS mise_onboarding_state (
			household_id TEXT PRIMARY KEY,
			current_tier INTEGER NOT NULL DEFAULT 0,
			tier_0_completed_at TEXT,
			tier_1_completed_at TEXT,
			tier_2_completed_at TEXT,
			tier_3_completed_at TEXT,
			active_question_bag_json TEXT,
			engagement_signal REAL NOT NULL DEFAULT 1.0,
			last_question_asked_at TEXT,
			questions_asked_count INTEGER NOT NULL DEFAULT 0,
			questions_answered_count INTEGER NOT NULL DEFAULT 0,
			questions_skipped_count INTEGER NOT NULL DEFAULT 0,
			updated_at_ms INTEGER NOT NULL
		)`,
	},
	{
		table: "mise_onboarding_responses",
		sql: `CREATE TABLE IF NOT EXISTS mise_onboarding_responses (
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
		)`,
	},
	{
		table: "ix_onboarding_responses_household",
		sql: `CREATE INDEX IF NOT EXISTS ix_onboarding_responses_household
			ON mise_onboarding_responses(household_id, asked_at_ms DESC)`,
	},
	{
		// Phase D calibration: PK now includes member_id so (household_id,
		// trait_name) can have multiple rows — one household-level row
		// (member_id='') plus one per member. Writers normalise NULL→'' so
		// uniqueness works in real SQLite (NULLs in PK are treated distinct).
		table: "mise_household_traits",
		sql: `CREATE TABLE IF NOT EXISTS mise_household_traits (
			household_id TEXT NOT NULL,
			trait_name TEXT NOT NULL,
			member_id TEXT NOT NULL DEFAULT '',
			trait_value REAL NOT NULL DEFAULT 0.5,
			confidence REAL NOT NULL DEFAULT 0,
			last_evidence_at_ms INTEGER NOT NULL,
			evidence_count INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (household_id, trait_name, member_id)
		)`,
	},
	{
		table: "mise_household_traditions",
		sql: `CREATE TABLE IF NOT EXISTS mise_household_traditions (
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
		)`,
	},
	{
		table: "ix_traditions_household",
		sql: `CREATE INDEX IF NOT EXISTS ix_traditions_household
			ON mise_household_traditions(household_id, active)`,
	},
];

const ONBOARDING_PROFILE_COLUMNS: ReadonlyArray<{ name: string; sql: string }> = [
	{
		name: "dinner_ritual",
		sql: `ALTER TABLE mise_household_profiles ADD COLUMN dinner_ritual TEXT`,
	},
	{
		name: "cook_frequency",
		sql: `ALTER TABLE mise_household_profiles ADD COLUMN cook_frequency TEXT`,
	},
	{
		name: "pantry_intake_mode",
		sql: `ALTER TABLE mise_household_profiles ADD COLUMN pantry_intake_mode TEXT`,
	},
	// Wave 7F — per-household IANA timezone. Read by the morning-brief cron
	// so each household's brief formats times in its local zone. The cron
	// itself still fires at 14:00 UTC for all households in Phase 1; Phase
	// 2 will shard by timezone to deliver at local 7am.
	{
		name: "timezone",
		sql: `ALTER TABLE mise_household_profiles ADD COLUMN timezone TEXT`,
	},
];

// Convenience: dedicated migration that ONLY adds the timezone column. Useful
// when the onboarding schema migration has already been run and we just want
// to pick up the new column without re-running everything else. Same
// idempotent try/catch pattern.
export async function migrateHouseholdTimezoneColumn(
	env: MiseGraphEnv,
): Promise<{ altered: string[] }> {
	const altered: string[] = [];
	try {
		await env.DB.prepare(
			`ALTER TABLE mise_household_profiles ADD COLUMN timezone TEXT`,
		).run();
		altered.push("timezone");
	} catch {
		// Already added (or base table missing) — non-fatal.
	}
	return { altered };
}

export async function migrateOnboardingSchema(
	env: MiseGraphEnv,
): Promise<{ migrated: string[]; altered: string[] }> {
	const migrated: string[] = [];
	for (const stmt of ONBOARDING_MIGRATIONS) {
		await env.DB.prepare(stmt.sql).run();
		migrated.push(stmt.table);
	}

	// ALTER TABLE … ADD COLUMN is the SQLite/D1 idiom for additive column
	// changes. It throws "duplicate column name" on second apply, so we
	// swallow that specific failure to keep the migration idempotent. Any
	// other failure (e.g. table missing because household-memory hasn't run
	// yet) is also tolerated — the caller is expected to apply migrations
	// in the standard order via the migrate-wave-7 / dedicated routes.
	const altered: string[] = [];
	for (const col of ONBOARDING_PROFILE_COLUMNS) {
		try {
			await env.DB.prepare(col.sql).run();
			altered.push(col.name);
		} catch {
			// Column already exists OR base table missing — both are non-fatal.
		}
	}

	return { migrated, altered };
}
