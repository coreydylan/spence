// Admin handler: apply household-memory schema migrations.
//
// Wave 5F's integrator wires this into a route on mise-graph-worker.ts;
// here we just expose a function that runs the SQL in
// schema-household-memory.sql against env.DB. CREATE TABLE IF NOT EXISTS
// makes this safe to call repeatedly.
//
// We don't import the .sql file at build time (Workers don't have a sane
// raw-text loader on every config); instead we keep the statements inline
// and ensure they match the SQL file. If you change schema-household-memory.sql,
// update the STATEMENTS array below — there's a parity check in u23 that
// verifies every CREATE TABLE in the SQL file appears here.

import type { MiseGraphEnv } from "./types";

interface MigrationStatement {
	table: string;        // table or index name (for the report)
	sql: string;
}

const STATEMENTS: MigrationStatement[] = [
	{
		table: "mise_household_profiles",
		sql: `CREATE TABLE IF NOT EXISTS mise_household_profiles (
			household_id TEXT PRIMARY KEY,
			display_name TEXT,
			people_count INTEGER NOT NULL DEFAULT 2,
			dietary_json TEXT NOT NULL DEFAULT '[]',
			equipment_json TEXT NOT NULL DEFAULT '[]',
			current_anchors_json TEXT NOT NULL DEFAULT '[]',
			cuisine_preferences_json TEXT NOT NULL DEFAULT '{}',
			default_pantry_json TEXT NOT NULL DEFAULT '[]',
			shop_preferences_json TEXT,
			notes TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
	},
	{
		table: "mise_conversation_threads",
		sql: `CREATE TABLE IF NOT EXISTS mise_conversation_threads (
			thread_id TEXT PRIMARY KEY,
			household_id TEXT NOT NULL,
			topic TEXT,
			state_json TEXT NOT NULL DEFAULT '{}',
			active_plan_id TEXT,
			last_turn_at TEXT NOT NULL,
			closed_at TEXT,
			message_count INTEGER NOT NULL DEFAULT 0
		)`,
	},
	{
		table: "idx_threads_household",
		sql: `CREATE INDEX IF NOT EXISTS idx_threads_household
			ON mise_conversation_threads(household_id, last_turn_at DESC)`,
	},
	{
		table: "mise_kitchen_inventory",
		sql: `CREATE TABLE IF NOT EXISTS mise_kitchen_inventory (
			inventory_id TEXT PRIMARY KEY,
			household_id TEXT NOT NULL,
			canonical_name TEXT NOT NULL,
			qty REAL,
			unit TEXT,
			storage TEXT,
			acquired_at TEXT,
			expires_at TEXT,
			source TEXT,
			consumed BOOLEAN DEFAULT FALSE,
			notes TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
	},
	{
		table: "idx_inventory_household",
		sql: `CREATE INDEX IF NOT EXISTS idx_inventory_household
			ON mise_kitchen_inventory(household_id, expires_at)`,
	},
	{
		table: "mise_anchor_evolution",
		sql: `CREATE TABLE IF NOT EXISTS mise_anchor_evolution (
			household_id TEXT NOT NULL,
			canonical_name TEXT NOT NULL,
			recorded_at TEXT NOT NULL,
			pressure REAL NOT NULL,
			trend TEXT,
			PRIMARY KEY (household_id, canonical_name, recorded_at)
		)`,
	},
	{
		table: "mise_meal_history",
		sql: `CREATE TABLE IF NOT EXISTS mise_meal_history (
			meal_history_id TEXT PRIMARY KEY,
			household_id TEXT NOT NULL,
			cooked_on TEXT NOT NULL,
			slot TEXT,
			title TEXT,
			cuisine_json TEXT NOT NULL DEFAULT '[]',
			format TEXT,
			anchors_json TEXT NOT NULL DEFAULT '[]',
			recorded_at TEXT NOT NULL
		)`,
	},
	{
		table: "idx_meal_history_household",
		sql: `CREATE INDEX IF NOT EXISTS idx_meal_history_household
			ON mise_meal_history(household_id, cooked_on DESC)`,
	},
	// ---- Wave 6: per-person HouseholdMember model (schema-members.sql). ----
	{
		table: "mise_household_members",
		sql: `CREATE TABLE IF NOT EXISTS mise_household_members (
			member_id TEXT PRIMARY KEY,
			household_id TEXT NOT NULL,
			display_name TEXT NOT NULL,
			age_group TEXT NOT NULL DEFAULT 'adult',
			dietary_json TEXT NOT NULL DEFAULT '[]',
			preferences_json TEXT NOT NULL DEFAULT '{}',
			safety_json TEXT NOT NULL DEFAULT '{}',
			active_skill_quests_json TEXT DEFAULT '[]',
			privacy_json TEXT NOT NULL DEFAULT '{}',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
	},
	{
		table: "idx_members_household",
		sql: `CREATE INDEX IF NOT EXISTS idx_members_household
			ON mise_household_members(household_id)`,
	},
	{
		table: "mise_member_skills",
		sql: `CREATE TABLE IF NOT EXISTS mise_member_skills (
			member_id TEXT NOT NULL,
			skill_name TEXT NOT NULL,
			confidence REAL NOT NULL DEFAULT 0,
			tasks_completed INTEGER NOT NULL DEFAULT 0,
			last_used_at TEXT,
			speed_multiplier REAL NOT NULL DEFAULT 1.0,
			notes TEXT,
			PRIMARY KEY (member_id, skill_name)
		)`,
	},
	{
		table: "mise_member_skill_history",
		sql: `CREATE TABLE IF NOT EXISTS mise_member_skill_history (
			history_id TEXT PRIMARY KEY,
			member_id TEXT NOT NULL,
			skill_name TEXT NOT NULL,
			task_id TEXT,
			meal_id TEXT,
			outcome TEXT NOT NULL,
			duration_actual_min REAL,
			duration_expected_min REAL,
			user_rating INTEGER,
			notes TEXT,
			recorded_at TEXT NOT NULL
		)`,
	},
	{
		table: "idx_skill_history_member",
		sql: `CREATE INDEX IF NOT EXISTS idx_skill_history_member
			ON mise_member_skill_history(member_id, skill_name, recorded_at DESC)`,
	},
	{
		table: "mise_member_presence",
		sql: `CREATE TABLE IF NOT EXISTS mise_member_presence (
			member_id TEXT PRIMARY KEY,
			state TEXT NOT NULL DEFAULT 'absent',
			current_task_id TEXT,
			current_session_id TEXT,
			last_ping_at TEXT,
			websocket_open INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL
		)`,
	},
];

export async function migrateHouseholdMemorySchema(
	env: MiseGraphEnv,
): Promise<{ migrated: string[] }> {
	const migrated: string[] = [];
	for (const stmt of STATEMENTS) {
		await env.DB.prepare(stmt.sql).run();
		migrated.push(stmt.table);
	}
	return { migrated };
}

export function householdMemoryMigrationStatements(): ReadonlyArray<MigrationStatement> {
	return STATEMENTS;
}
