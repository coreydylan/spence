// Audit-log helpers for the replan webhook.
//
// Pairs with src/mise-graph/schema-replan-events.sql. Wave 5F applies the
// migration; this module owns the read/write surface so the webhook can stay
// thin. recordReplanEvent is best-effort (the webhook handler swallows
// exceptions) — listReplanEvents is the read path used by the
// `/mise-graph/replan/log` companion route.

import type { MiseGraphEnv } from "./types";
import type { ReplanResult } from "./replan-events";

export interface ReplanEventRow {
	event_id: string;
	event_kind: string;
	applied_at: string;
	human_summary: string;
	applied: boolean;
}

export async function recordReplanEvent(env: MiseGraphEnv, result: ReplanResult): Promise<void> {
	const event_id = generateEventId();
	const applied_at = new Date().toISOString();
	await env.DB.prepare(`
		INSERT INTO mise_replan_events (
			event_id,
			plan_id,
			event_kind,
			event_json,
			applied,
			applied_at,
			ripple_summary_json,
			human_summary
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`).bind(
		event_id,
		result.plan_id,
		result.event.kind,
		JSON.stringify(result.event),
		result.applied ? 1 : 0,
		applied_at,
		JSON.stringify(result.ripple_summary),
		result.human_summary,
	).run();
}

export async function listReplanEvents(
	env: MiseGraphEnv,
	plan_id: string,
	limit: number = 50,
): Promise<ReplanEventRow[]> {
	const safeLimit = Math.min(Math.max(limit | 0, 1), 500);
	const stmt = env.DB.prepare(`
		SELECT event_id, event_kind, applied, applied_at, human_summary
		FROM mise_replan_events
		WHERE plan_id = ?
		ORDER BY applied_at DESC
		LIMIT ?
	`).bind(plan_id, safeLimit);
	const result = await stmt.all<{
		event_id: string;
		event_kind: string;
		applied: number | null;
		applied_at: string | null;
		human_summary: string | null;
	}>();
	return (result.results || []).map(row => ({
		event_id: row.event_id,
		event_kind: row.event_kind,
		applied_at: row.applied_at || "",
		human_summary: row.human_summary || "",
		applied: !!row.applied,
	}));
}

function generateEventId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return `replan_${crypto.randomUUID()}`;
	}
	return `replan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
