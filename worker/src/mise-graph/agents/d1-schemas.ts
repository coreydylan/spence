// MealAgent D1 schema migration (Wave 7B Track A).
//
// MealAgent's per-phase entry handlers write rows into three new D1 tables:
//   * mise_meal_briefings
//   * mise_member_notifications
//   * mise_cook_sessions
//
// This module exposes `migrateMealAgentSchemas(env)` which CREATE-IF-NOT-
// EXISTS each table. Wave 7B-Phase2 wires this into a /mise-graph/admin/
// migrate-meal-agent route on the worker (matching the existing
// migrate-calendar / migrate-household-memory pattern). For Wave 7B Track A
// we just publish the migrate fn — Phase 2 owns the route.
//
// The migration is idempotent and side-effect free on already-applied
// tables, matching how migrateCalendarSchema / migrateHouseholdMemorySchema
// behave today.

import type { MiseGraphEnv } from "../types";

interface MigrationStmt {
	table: string;
	sql: string;
}

const MEAL_AGENT_MIGRATIONS: ReadonlyArray<MigrationStmt> = [
	{
		table: "mise_meal_briefings",
		sql: `CREATE TABLE IF NOT EXISTS mise_meal_briefings (
			briefing_id TEXT PRIMARY KEY,
			household_id TEXT,
			plan_id TEXT,
			meal_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			created_at TEXT NOT NULL
		)`,
	},
	{
		table: "idx_meal_briefings_meal",
		sql: `CREATE INDEX IF NOT EXISTS idx_meal_briefings_meal
			ON mise_meal_briefings(meal_id, created_at DESC)`,
	},
	{
		table: "idx_meal_briefings_household",
		sql: `CREATE INDEX IF NOT EXISTS idx_meal_briefings_household
			ON mise_meal_briefings(household_id, created_at DESC)`,
	},
	{
		table: "mise_member_notifications",
		sql: `CREATE TABLE IF NOT EXISTS mise_member_notifications (
			notification_id TEXT PRIMARY KEY,
			household_id TEXT,
			member_id TEXT NOT NULL,
			source_agent_kind TEXT NOT NULL,
			source_agent_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			title TEXT NOT NULL,
			body TEXT,
			payload_json TEXT,
			created_at TEXT NOT NULL,
			acknowledged_at TEXT
		)`,
	},
	{
		table: "idx_member_notif_member",
		sql: `CREATE INDEX IF NOT EXISTS idx_member_notif_member
			ON mise_member_notifications(member_id, created_at DESC)`,
	},
	{
		table: "idx_member_notif_source",
		sql: `CREATE INDEX IF NOT EXISTS idx_member_notif_source
			ON mise_member_notifications(source_agent_kind, source_agent_id)`,
	},
	{
		table: "mise_cook_sessions",
		sql: `CREATE TABLE IF NOT EXISTS mise_cook_sessions (
			cook_session_id TEXT PRIMARY KEY,
			household_id TEXT,
			plan_id TEXT,
			meal_id TEXT NOT NULL,
			state TEXT NOT NULL,
			started_at TEXT NOT NULL,
			stale_at TEXT,
			ended_at TEXT,
			ended_reason TEXT,
			meta_json TEXT
		)`,
	},
	{
		table: "idx_cook_sessions_meal",
		sql: `CREATE INDEX IF NOT EXISTS idx_cook_sessions_meal
			ON mise_cook_sessions(meal_id, started_at DESC)`,
	},
	{
		table: "idx_cook_sessions_plan",
		sql: `CREATE INDEX IF NOT EXISTS idx_cook_sessions_plan
			ON mise_cook_sessions(plan_id, started_at DESC)`,
	},
];

export async function migrateMealAgentSchemas(
	env: MiseGraphEnv,
): Promise<{ migrated: string[] }> {
	const migrated: string[] = [];
	for (const stmt of MEAL_AGENT_MIGRATIONS) {
		await env.DB.prepare(stmt.sql).run();
		migrated.push(stmt.table);
	}
	return { migrated };
}

export function mealAgentMigrationStatements(): ReadonlyArray<MigrationStmt> {
	return MEAL_AGENT_MIGRATIONS;
}
