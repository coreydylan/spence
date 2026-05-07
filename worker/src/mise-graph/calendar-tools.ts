// Calendar-tools — read household calendar windows and stage Spence-created
// events for sync.
//
// Two halves:
//
//   1. READ — `readCalendarWindows` returns a per-day rollup of busy blocks
//      plus a derived "cook_window" (longest free 30+ minute block in the
//      afternoon/evening) and an "eat_window" (when the household can eat —
//      default 18:30–20:00 minus any overlap). For demo we read busy blocks
//      from a synthetic D1 store (mise_calendar_blocks). For production we'd
//      sync from Google Calendar via OAuth, but that's a separate wave —
//      this layer keeps the schema stable so the agent can call read tools
//      identically in both environments.
//
//   2. WRITE — `stageCalendarEvent` records Spence's intent to put a meal /
//      cook / shop on the user's calendar. Events stay `staged` in D1 until
//      a future OAuth-sync layer pushes them to Google. The agent can list
//      and cancel them by entity_id, which is how cascading replans keep
//      the calendar in sync with the plan.
//
// All times are ISO timestamps (`YYYY-MM-DDTHH:MM[:SS][TZ]`); the cook /
// eat / shop window helpers operate on local-clock boundaries derived from
// the busy block start_at strings, which means callers should already be
// passing tz-aware ISO timestamps (or at least consistent ones across both
// busy blocks and queries).

import type { MiseGraphEnv } from "./types";

export type CalendarSource = "google" | "icloud" | "manual";

export interface CalendarBlock {
	start: string;
	end: string;
	title: string;
	busy: boolean;
	source: string;
	location?: string;
	description?: string;
	metadata?: Record<string, unknown>;
}

export interface CalendarWindowSlice {
	start: string;
	end: string;
	duration_min?: number;
}

export interface CalendarWindow {
	date: string;
	busy_blocks: CalendarBlock[];
	cook_window?: CalendarWindowSlice;   // longest free 30+ min afternoon/evening block
	eat_window?: CalendarWindowSlice;    // when household can eat (~18:30–20:00 minus busy)
	shop_window?: CalendarWindowSlice;   // available block for grocery shopping
}

export interface CalendarBlockInput {
	start: string;
	end: string;
	title: string;
	busy?: boolean;
	source?: CalendarSource | string;
	location?: string;
	description?: string;
	metadata?: Record<string, unknown>;
}

export interface CalendarEventInput {
	start: string;
	end: string;
	title: string;
	description?: string;
	location?: string;
	metadata: {
		plan_id: string;
		entity_id: string;
		entity_type: "shop" | "cook" | "meal";
	};
}

export type StagedEventStatus = "staged" | "pushed" | "canceled";

export interface StagedCalendarEvent extends CalendarEventInput {
	event_id: string;
	status: StagedEventStatus;
}

interface CalendarBlockRow {
	block_id: string;
	household_id: string;
	start_at: string;
	end_at: string;
	title: string;
	busy: number | boolean;
	source: string;
	location: string | null;
	description: string | null;
	metadata_json: string | null;
}

interface StagedEventRow {
	event_id: string;
	household_id: string;
	plan_id: string | null;
	entity_id: string;
	entity_type: string;
	start_at: string;
	end_at: string;
	title: string;
	description: string | null;
	location: string | null;
	metadata_json: string;
	status: string;
	created_at: string;
	updated_at: string;
}

// ─── Migration ────────────────────────────────────────────────────────────

const CALENDAR_MIGRATIONS: Array<{ table: string; sql: string }> = [
	{
		table: "mise_calendar_blocks",
		sql: `CREATE TABLE IF NOT EXISTS mise_calendar_blocks (
			block_id TEXT PRIMARY KEY,
			household_id TEXT NOT NULL,
			start_at TEXT NOT NULL,
			end_at TEXT NOT NULL,
			title TEXT NOT NULL,
			busy INTEGER NOT NULL DEFAULT 1,
			source TEXT NOT NULL DEFAULT 'manual',
			location TEXT,
			description TEXT,
			metadata_json TEXT
		)`,
	},
	{
		table: "idx_calendar_household",
		sql: `CREATE INDEX IF NOT EXISTS idx_calendar_household
			ON mise_calendar_blocks(household_id, start_at)`,
	},
	{
		table: "mise_staged_calendar_events",
		sql: `CREATE TABLE IF NOT EXISTS mise_staged_calendar_events (
			event_id TEXT PRIMARY KEY,
			household_id TEXT NOT NULL,
			plan_id TEXT,
			entity_id TEXT NOT NULL,
			entity_type TEXT NOT NULL,
			start_at TEXT NOT NULL,
			end_at TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT,
			location TEXT,
			metadata_json TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'staged',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
	},
	{
		table: "idx_staged_events_plan",
		sql: `CREATE INDEX IF NOT EXISTS idx_staged_events_plan
			ON mise_staged_calendar_events(plan_id, status)`,
	},
];

export async function migrateCalendarSchema(env: MiseGraphEnv): Promise<{ migrated: string[] }> {
	const migrated: string[] = [];
	for (const stmt of CALENDAR_MIGRATIONS) {
		await env.DB.prepare(stmt.sql).run();
		migrated.push(stmt.table);
	}
	return { migrated };
}

export function calendarMigrationStatements(): ReadonlyArray<{ table: string; sql: string }> {
	return CALENDAR_MIGRATIONS;
}

// ─── Read: busy blocks + window derivation ────────────────────────────────

export async function readCalendarWindows(
	env: MiseGraphEnv,
	household_id: string,
	startDate: string,
	endDate: string,
): Promise<CalendarWindow[]> {
	const hh = (household_id || "").trim();
	if (!hh) return [];
	if (!isIsoDate(startDate) || !isIsoDate(endDate)) return [];
	const rangeStart = `${startDate}T00:00`;
	const rangeEnd = `${endDate}T23:59`;

	let rows: CalendarBlockRow[] = [];
	try {
		const result = await env.DB.prepare(
			`SELECT block_id, household_id, start_at, end_at, title, busy, source,
			        location, description, metadata_json
			 FROM mise_calendar_blocks
			 WHERE household_id = ?
			   AND start_at >= ?
			   AND start_at <= ?
			 ORDER BY start_at ASC
			 LIMIT 1000`,
		).bind(hh, rangeStart, rangeEnd).all<CalendarBlockRow>();
		rows = (result.results || []) as CalendarBlockRow[];
	} catch {
		rows = [];
	}

	const dates = enumerateDates(startDate, endDate);
	const blocksByDate = new Map<string, CalendarBlock[]>();
	for (const date of dates) blocksByDate.set(date, []);
	for (const row of rows) {
		const key = (row.start_at || "").slice(0, 10);
		const arr = blocksByDate.get(key);
		if (!arr) continue;
		arr.push(rowToBlock(row));
	}

	return dates.map(date => {
		const busy_blocks = (blocksByDate.get(date) || []).filter(b => b.busy);
		const cook_window = deriveCookWindow(date, busy_blocks);
		const eat_window = deriveEatWindow(date, busy_blocks);
		const shop_window = deriveShopWindow(date, busy_blocks);
		const out: CalendarWindow = { date, busy_blocks };
		if (cook_window) out.cook_window = cook_window;
		if (eat_window) out.eat_window = eat_window;
		if (shop_window) out.shop_window = shop_window;
		return out;
	});
}

export async function addCalendarBlock(
	env: MiseGraphEnv,
	household_id: string,
	block: CalendarBlockInput,
): Promise<{ block_id: string }> {
	const hh = (household_id || "").trim();
	if (!hh) throw new Error("addCalendarBlock: household_id required");
	if (!isIsoTimestamp(block?.start) || !isIsoTimestamp(block?.end)) {
		throw new Error("addCalendarBlock: start/end must be ISO timestamps");
	}
	if (!block.title || typeof block.title !== "string") {
		throw new Error("addCalendarBlock: title required");
	}
	const block_id = `cal_block_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
	const busy = block.busy === false ? 0 : 1;
	const source = (block.source || "manual").toString().trim() || "manual";
	const metadata = block.metadata ? JSON.stringify(block.metadata) : null;

	await env.DB.prepare(
		`INSERT OR REPLACE INTO mise_calendar_blocks
			(block_id, household_id, start_at, end_at, title, busy, source,
			 location, description, metadata_json)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(
		block_id,
		hh,
		block.start,
		block.end,
		block.title,
		busy,
		source,
		block.location ?? null,
		block.description ?? null,
		metadata,
	).run();

	return { block_id };
}

// ─── Stage / list / cancel events ────────────────────────────────────────

export async function stageCalendarEvent(
	env: MiseGraphEnv,
	household_id: string,
	event: CalendarEventInput,
): Promise<{ event_id: string }> {
	const hh = (household_id || "").trim();
	if (!hh) throw new Error("stageCalendarEvent: household_id required");
	if (!isIsoTimestamp(event?.start) || !isIsoTimestamp(event?.end)) {
		throw new Error("stageCalendarEvent: start/end must be ISO timestamps");
	}
	if (!event?.title) throw new Error("stageCalendarEvent: title required");
	if (!event?.metadata?.plan_id || !event?.metadata?.entity_id || !event?.metadata?.entity_type) {
		throw new Error("stageCalendarEvent: metadata.{plan_id, entity_id, entity_type} required");
	}
	const entityType = event.metadata.entity_type;
	if (entityType !== "shop" && entityType !== "cook" && entityType !== "meal") {
		throw new Error(`stageCalendarEvent: entity_type must be shop|cook|meal (got ${entityType})`);
	}

	const event_id = `cal_event_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
	const now = new Date().toISOString();
	const metadata_json = JSON.stringify(event.metadata);

	await env.DB.prepare(
		`INSERT OR REPLACE INTO mise_staged_calendar_events
			(event_id, household_id, plan_id, entity_id, entity_type, start_at, end_at,
			 title, description, location, metadata_json, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(
		event_id,
		hh,
		event.metadata.plan_id,
		event.metadata.entity_id,
		entityType,
		event.start,
		event.end,
		event.title,
		event.description ?? null,
		event.location ?? null,
		metadata_json,
		"staged",
		now,
		now,
	).run();

	return { event_id };
}

export async function listStagedEvents(
	env: MiseGraphEnv,
	household_id: string,
	plan_id?: string,
): Promise<StagedCalendarEvent[]> {
	const hh = (household_id || "").trim();
	if (!hh) return [];

	let rows: StagedEventRow[] = [];
	try {
		if (plan_id) {
			const result = await env.DB.prepare(
				`SELECT event_id, household_id, plan_id, entity_id, entity_type,
				        start_at, end_at, title, description, location,
				        metadata_json, status, created_at, updated_at
				 FROM mise_staged_calendar_events
				 WHERE household_id = ? AND plan_id = ?
				 ORDER BY start_at ASC
				 LIMIT 500`,
			).bind(hh, plan_id).all<StagedEventRow>();
			rows = (result.results || []) as StagedEventRow[];
		} else {
			const result = await env.DB.prepare(
				`SELECT event_id, household_id, plan_id, entity_id, entity_type,
				        start_at, end_at, title, description, location,
				        metadata_json, status, created_at, updated_at
				 FROM mise_staged_calendar_events
				 WHERE household_id = ?
				 ORDER BY start_at ASC
				 LIMIT 500`,
			).bind(hh).all<StagedEventRow>();
			rows = (result.results || []) as StagedEventRow[];
		}
	} catch {
		return [];
	}

	return rows.map(rowToEvent);
}

export async function cancelStagedEvent(env: MiseGraphEnv, event_id: string): Promise<void> {
	const id = (event_id || "").trim();
	if (!id) throw new Error("cancelStagedEvent: event_id required");
	const now = new Date().toISOString();
	await env.DB.prepare(
		`UPDATE mise_staged_calendar_events
		    SET status = ?, updated_at = ?
		  WHERE event_id = ?`,
	).bind("canceled", now, id).run();
}

// ─── Window derivation ────────────────────────────────────────────────────

// "Cook window" — longest free contiguous block of >=30 minutes starting at
// or after 14:00 (afternoon prep) and ending at or before 21:00 (cleanup
// done before late evening). We carve the 14:00–21:00 day-bar into sub-bars
// minus busy blocks and pick the widest.
function deriveCookWindow(date: string, busy: CalendarBlock[]): CalendarWindowSlice | undefined {
	return widestFreeSlice(date, busy, 14, 0, 21, 0, 30);
}

// "Eat window" — typical dinner hour 18:30–20:00 minus busy overlaps.
function deriveEatWindow(date: string, busy: CalendarBlock[]): CalendarWindowSlice | undefined {
	return widestFreeSlice(date, busy, 18, 30, 20, 0, 20);
}

// "Shop window" — Saturday/Sunday morning ideally; weekday fallback uses
// 09:00–11:00.
function deriveShopWindow(date: string, busy: CalendarBlock[]): CalendarWindowSlice | undefined {
	const day = weekdayIndex(date);
	const sat = day === 6;
	const sun = day === 0;
	const startHour = sat || sun ? 8 : 9;
	const endHour = sat || sun ? 12 : 11;
	return widestFreeSlice(date, busy, startHour, 0, endHour, 0, 30);
}

function widestFreeSlice(
	date: string,
	busy: CalendarBlock[],
	startHour: number,
	startMin: number,
	endHour: number,
	endMin: number,
	minDurationMin: number,
): CalendarWindowSlice | undefined {
	const dayStart = minutesAt(date, startHour, startMin);
	const dayEnd = minutesAt(date, endHour, endMin);
	if (dayEnd <= dayStart) return undefined;

	// Convert busy blocks to minute-of-window ranges, clipped to the day-bar.
	const overlaps: Array<[number, number]> = [];
	for (const block of busy) {
		const bStart = parseToMinutes(block.start);
		const bEnd = parseToMinutes(block.end);
		if (bStart === null || bEnd === null) continue;
		const a = Math.max(bStart, dayStart);
		const b = Math.min(bEnd, dayEnd);
		if (b <= a) continue;
		overlaps.push([a, b]);
	}
	overlaps.sort((a, b) => a[0] - b[0]);
	const merged: Array<[number, number]> = [];
	for (const [a, b] of overlaps) {
		if (!merged.length || a > merged[merged.length - 1][1]) {
			merged.push([a, b]);
		} else {
			merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], b);
		}
	}

	let best: { start: number; end: number } | null = null;
	let cursor = dayStart;
	for (const [a, b] of merged) {
		if (a > cursor) {
			const dur = a - cursor;
			if (dur >= minDurationMin && (!best || dur > best.end - best.start)) {
				best = { start: cursor, end: a };
			}
		}
		cursor = Math.max(cursor, b);
	}
	if (cursor < dayEnd) {
		const dur = dayEnd - cursor;
		if (dur >= minDurationMin && (!best || dur > best.end - best.start)) {
			best = { start: cursor, end: dayEnd };
		}
	}
	if (!best) return undefined;
	return {
		start: minutesToIso(date, best.start),
		end: minutesToIso(date, best.end),
		duration_min: best.end - best.start,
	};
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function rowToBlock(row: CalendarBlockRow): CalendarBlock {
	const block: CalendarBlock = {
		start: row.start_at,
		end: row.end_at,
		title: row.title,
		busy: row.busy === 1 || row.busy === true,
		source: row.source || "manual",
	};
	if (row.location) block.location = row.location;
	if (row.description) block.description = row.description;
	if (row.metadata_json) {
		try {
			const parsed = JSON.parse(row.metadata_json);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				block.metadata = parsed as Record<string, unknown>;
			}
		} catch {
			// metadata_json malformed; skip.
		}
	}
	return block;
}

function rowToEvent(row: StagedEventRow): StagedCalendarEvent {
	let metadata: CalendarEventInput["metadata"] = {
		plan_id: row.plan_id || "",
		entity_id: row.entity_id,
		entity_type: (row.entity_type as "shop" | "cook" | "meal"),
	};
	try {
		const parsed = JSON.parse(row.metadata_json) as Record<string, unknown>;
		if (parsed && typeof parsed === "object") {
			metadata = {
				plan_id: typeof parsed.plan_id === "string" ? parsed.plan_id : metadata.plan_id,
				entity_id: typeof parsed.entity_id === "string" ? parsed.entity_id : metadata.entity_id,
				entity_type: (typeof parsed.entity_type === "string"
					? parsed.entity_type
					: metadata.entity_type) as "shop" | "cook" | "meal",
			};
		}
	} catch {
		// metadata fallback already populated from columns.
	}
	const out: StagedCalendarEvent = {
		event_id: row.event_id,
		start: row.start_at,
		end: row.end_at,
		title: row.title,
		metadata,
		status: normalizeStatus(row.status),
	};
	if (row.description) out.description = row.description;
	if (row.location) out.location = row.location;
	return out;
}

function normalizeStatus(value: string): StagedEventStatus {
	if (value === "pushed" || value === "canceled") return value;
	return "staged";
}

function isIsoDate(value: unknown): value is string {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value);
}

function enumerateDates(start: string, end: string): string[] {
	const startMs = Date.parse(`${start}T00:00:00Z`);
	const endMs = Date.parse(`${end}T00:00:00Z`);
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return [];
	const out: string[] = [];
	const cursor = new Date(startMs);
	while (cursor.getTime() <= endMs && out.length < 60) {
		out.push(cursor.toISOString().slice(0, 10));
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}
	return out;
}

function weekdayIndex(date: string): number {
	if (!isIsoDate(date)) return -1;
	const ms = Date.parse(`${date}T12:00:00Z`);
	if (!Number.isFinite(ms)) return -1;
	return new Date(ms).getUTCDay();
}

// We treat ISO timestamps as local-clock — `2026-05-09T18:30` parses to
// minutes-from-midnight on its own date; offsets are intentionally
// ignored because the synthetic blocks and the cook/eat windows operate
// on the same local-clock axis. If callers feed us tz-aware strings, the
// derived windows will keep that tz prefix on the output.
function parseToMinutes(value: string): number | null {
	if (typeof value !== "string") return null;
	const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
	if (!m) return null;
	const date = `${m[1]}-${m[2]}-${m[3]}`;
	const baseMs = Date.parse(`${date}T00:00:00Z`);
	if (!Number.isFinite(baseMs)) return null;
	return Math.round(baseMs / 60000) + Number(m[4]) * 60 + Number(m[5]);
}

function minutesAt(date: string, hour: number, minute: number): number {
	const baseMs = Date.parse(`${date}T00:00:00Z`);
	if (!Number.isFinite(baseMs)) return 0;
	return Math.round(baseMs / 60000) + hour * 60 + minute;
}

function minutesToIso(date: string, totalMinutes: number): string {
	const baseMs = Date.parse(`${date}T00:00:00Z`);
	if (!Number.isFinite(baseMs)) return `${date}T00:00`;
	const baseMin = Math.round(baseMs / 60000);
	const offset = totalMinutes - baseMin;
	const hh = Math.floor(offset / 60);
	const mm = offset % 60;
	return `${date}T${two(hh)}:${two(mm)}`;
}

function two(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}
