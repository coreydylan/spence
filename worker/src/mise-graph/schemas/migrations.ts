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
