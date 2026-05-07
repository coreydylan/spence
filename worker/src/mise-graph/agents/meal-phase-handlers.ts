// Per-phase entry handlers for MealAgent (Wave 7B Track A).
//
// Each handler is a PURE async function: it takes (env, state, deps) and
// returns a structured result describing the work it performed (rows
// written, notifications fired, alarms requested). The MealAgent DO wraps
// these handlers and applies their results — that split exists so we can
// unit-test the phase logic without booting the Cloudflare runtime
// (the `agents` SDK fails to import under Node).
//
// State machine reminder:
//   planned → pre_eve → day_of → cook_window → active_cook → eaten → archived
// Each non-terminal phase can also short-circuit to `archived` (the matrix
// in agents/base.ts uses `archived` as both natural end and cancellation
// terminal — Wave 7B Track A's `/cancel` route writes a "cancelled:..."
// reason on that transition so handlers can branch on it).

import type { MiseGraphEnv } from "../types";
import { readCalendarWindows, type CalendarBlock } from "../calendar-tools";
import { fetchWeatherForecast } from "../weather-tools";
import type { AgentSqlSink } from "./base";
import {
	claimEquipment,
	claimEquipmentForMeal,
	ensureEquipmentDefined,
	releaseClaimsFor,
	releaseEquipmentForMeal,
	type ClaimConflict,
	type ClaimEquipmentResult,
	type EquipmentClaimRecord,
} from "./equipment-stub";

// ─── Shared types ──────────────────────────────────────────────────────────

export type MealPhaseName =
	| "planned"
	| "pre_eve"
	| "day_of"
	| "cook_window"
	| "active_cook"
	| "eaten"
	| "archived";

/**
 * The cached snapshot a MealAgent loads from D1 at /init time. Phase
 * handlers receive this so they don't need to re-load the active plan
 * for every alarm.
 */
export interface MealSnapshot {
	meal_id: string;
	plan_id: string;
	household_id: string | null;
	date: string;                      // YYYY-MM-DD
	slot: string;                      // breakfast | lunch | dinner | snack
	format: string | null;
	cuisine: string[];
	recipe_id: string | null;
	cook_window_start_ms: number;
	cook_window_end_ms: number;
	eat_window_start_ms: number;
	eat_window_end_ms: number;
	equipment: string[];
	// People count from the meal record. Used by Track B's window adjustment
	// when adult_member_ids isn't passed at /init (which is the common case
	// since PlanAgent spawns MealAgents without member context).
	people: number | null;
}

/**
 * Optional location context — supplied via /init body. When absent, weather
 * fetches are skipped and the briefing records null weather.
 */
export interface LocationContext {
	lat?: number;
	lng?: number;
	city?: string;
	tz?: string;
}

/**
 * Adult member id list, supplied at /init time (we don't reach into
 * MemberAgent DOs from this track). cook_window_entry uses this list to
 * fan out member_call notifications.
 */
export interface AdultsList {
	adult_member_ids: string[];
}

export interface PhaseHandlerDeps {
	env: MiseGraphEnv;
	now_ms: number;
	location?: LocationContext;
	adults: AdultsList;
}

export interface BriefingRow {
	briefing_id: string;
	household_id: string | null;
	plan_id: string;
	meal_id: string;
	kind: "pre_eve" | "day_of" | "cook_window";
	payload_json: string;
	created_at: string;
}

export interface NotificationRow {
	notification_id: string;
	household_id: string | null;
	// null when fan-out can't resolve a specific recipient (e.g. household-
	// wide alert when adult_member_ids isn't supplied to MealAgent.init).
	member_id: string | null;
	source_agent_kind: string;
	source_agent_id: string;
	kind: string;
	title: string;
	body: string | null;
	payload_json: string | null;
	created_at: string;
}

export interface CookSessionRow {
	cook_session_id: string;
	household_id: string | null;
	plan_id: string;
	meal_id: string;
	state: "started" | "stale" | "ended";
	started_at: string;
	stale_at: string | null;
	ended_at: string | null;
	ended_reason: string | null;
	meta_json: string | null;
}

export interface PhaseHandlerResult {
	phase: MealPhaseName;
	briefings: BriefingRow[];
	notifications: NotificationRow[];
	cook_sessions: CookSessionRow[];
	cook_session_marker?: {
		cook_session_id: string;
		state: "started" | "stale" | "ended";
		ended_reason?: string;
		meta_json?: string;
	};
	equipment_claim?: ClaimEquipmentResult;
	/**
	 * Track D — household-scoped equipment claim result emitted by
	 * cook_window_entry. Distinct from `equipment_claim` (legacy per-DO stub
	 * shape) — `household_equipment_claim` is the canonical D1-backed
	 * tracker output: it sees claims from every meal/task/shop in the
	 * household, so it's what conflict notifications & next-cook scheduling
	 * read from. Absent when household_id is unknown or equipment is empty.
	 */
	household_equipment_claim?: {
		ok: boolean;
		granted: EquipmentClaimRecord[];
		conflicts: ClaimConflict[];
	};
	equipment_released?: { released: number };
	notes: string[];
	next_alarm_at_ms: number | null;
}

// ─── Helpers (pure, exported for tests) ────────────────────────────────────

/**
 * Default mealtime windows — used when the meal record doesn't carry
 * explicit cook_window/eat_window fields. Mirrors calendar-tools window
 * derivation defaults so the two systems are aligned even if no calendar
 * blocks have been logged.
 */
export function defaultWindowsForSlot(date: string, slot: string): {
	cook_window_start_ms: number;
	cook_window_end_ms: number;
	eat_window_start_ms: number;
	eat_window_end_ms: number;
} {
	const baseMs = Date.parse(`${date}T00:00:00.000Z`);
	const safe = Number.isFinite(baseMs) ? baseMs : Date.now();
	const lower = (slot || "dinner").toLowerCase();
	// Local-clock minute offsets by slot. We treat the date as UTC-midnight
	// here intentionally — the same local-clock convention that
	// calendar-tools.ts uses (parseToMinutes ignores tz offsets).
	const map: Record<string, [number, number, number, number]> = {
		breakfast: [6 * 60, 8 * 60, 7 * 60, 8 * 60],
		lunch:     [11 * 60, 12 * 60 + 30, 12 * 60, 13 * 60],
		dinner:    [17 * 60, 18 * 60 + 30, 18 * 60 + 30, 20 * 60],
		snack:     [15 * 60, 15 * 60 + 30, 15 * 60, 16 * 60],
	};
	const cfg = map[lower] || map.dinner;
	return {
		cook_window_start_ms: safe + cfg[0] * 60_000,
		cook_window_end_ms:   safe + cfg[1] * 60_000,
		eat_window_start_ms:  safe + cfg[2] * 60_000,
		eat_window_end_ms:    safe + cfg[3] * 60_000,
	};
}

/**
 * Wave 7B Track B: people-aware cook window adjustment.
 *
 * Pure function. Shifts `cook_window_start_ms` based on:
 *   - `people` count: guests (>2) shift earlier by (people-2)*10 min,
 *     capped at 60 min earlier. Solo dining (1 person) shifts later by
 *     15 min — solo cooks can be quicker.
 *   - `cook_active_min`: long-prep meals (>60 min active cook) shift
 *     earlier by (cook_active_min - 60) min so the suggested-start fits
 *     inside the window.
 *
 * Shifts compose. `cook_window_end_ms`, `eat_window_start_ms`, and
 * `eat_window_end_ms` are unchanged — the eating time stays anchored
 * to the household's social-clock; only the cooking-start shifts.
 *
 * Exported for unit tests + meal-agent.handleInit.
 */
export function adjustWindowsForPeopleAndCook(
	windows: {
		cook_window_start_ms: number;
		cook_window_end_ms: number;
		eat_window_start_ms: number;
		eat_window_end_ms: number;
	},
	people: number | null | undefined,
	cook_active_min: number | null | undefined,
): {
	cook_window_start_ms: number;
	cook_window_end_ms: number;
	eat_window_start_ms: number;
	eat_window_end_ms: number;
} {
	let earlierMin = 0;
	let laterMin = 0;

	const p = typeof people === "number" && Number.isFinite(people) ? Math.floor(people) : null;
	if (p !== null) {
		if (p > 2) {
			// (people - 2) * 10, capped at 60 min earlier.
			earlierMin += Math.min((p - 2) * 10, 60);
		} else if (p === 1) {
			laterMin += 15;
		}
	}

	const cam = typeof cook_active_min === "number" && Number.isFinite(cook_active_min)
		? cook_active_min
		: null;
	if (cam !== null && cam > 60) {
		earlierMin += cam - 60;
	}

	const deltaMs = (laterMin - earlierMin) * 60_000;
	return {
		cook_window_start_ms: windows.cook_window_start_ms + deltaMs,
		cook_window_end_ms:   windows.cook_window_end_ms,
		eat_window_start_ms:  windows.eat_window_start_ms,
		eat_window_end_ms:    windows.eat_window_end_ms,
	};
}

export function generateBriefingId(now_ms: number): string {
	return `brief_${now_ms.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
export function generateNotificationId(now_ms: number): string {
	return `notif_${now_ms.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
export function generateCookSessionId(now_ms: number): string {
	return `cook_${now_ms.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── pre_eve_entry ─────────────────────────────────────────────────────────

/**
 * Entry handler for `pre_eve` phase. Writes a briefing row that captures:
 *   - tomorrow's weather forecast (best-effort; null if no location)
 *   - calendar windows for the meal's date (cook/eat/shop windows + busy)
 *   - leftover availability — for Track A this is a placeholder list of
 *     the snapshot's `equipment` field; PlanAgent integration in Phase 2
 *     will replace with `plan_read_batches` output.
 *   - equipment readiness flags (currently the meal's declared equipment)
 *
 * Schedules `day_of` alarm at `eat_window_start_ms - 12h` (the prompt's
 * approximation of "start of meal date").
 */
export async function pre_eve_entry(
	snapshot: MealSnapshot,
	deps: PhaseHandlerDeps,
): Promise<PhaseHandlerResult> {
	const notes: string[] = [];
	let weather: unknown = null;
	if (deps.location && typeof deps.location.lat === "number" && typeof deps.location.lng === "number") {
		try {
			const summary = await fetchWeatherForecast(
				{ lat: deps.location.lat, lng: deps.location.lng },
				snapshot.date,
				snapshot.date,
				{ timezone: deps.location.tz, city: deps.location.city },
			);
			weather = {
				pattern_summary: summary.pattern_summary,
				cooking_hints: summary.cooking_hints,
				forecast: summary.forecast,
			};
		} catch (err) {
			notes.push(`weather_fetch_failed:${err instanceof Error ? err.message : String(err)}`);
		}
	}

	let calendar: unknown = null;
	let calendar_busy_blocks: CalendarBlock[] = [];
	if (snapshot.household_id) {
		try {
			const windows = await readCalendarWindows(
				deps.env,
				snapshot.household_id,
				snapshot.date,
				snapshot.date,
			);
			calendar = windows[0] || null;
			calendar_busy_blocks = windows[0]?.busy_blocks || [];
		} catch (err) {
			notes.push(`calendar_read_failed:${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// Track C — calendar conflict awareness for the pre_eve briefing.
	//
	// Each cook/eat window is a [start_ms, end_ms] interval; a busy block
	// "conflicts" if it overlaps either window. We also compute a "tight"
	// flag for the cook window — true when there is free time but the
	// largest contiguous free interval inside cook_window is < 60 min OR
	// less than half the original window span (whichever is larger). Since
	// MealSnapshot doesn't carry a `cook_active_min` (Track B/D may add it
	// later), we use the half-window heuristic so cook_window_tight is
	// meaningful regardless of recipe duration.
	const conflict = computeCalendarConflict({
		cookStart: snapshot.cook_window_start_ms,
		cookEnd: snapshot.cook_window_end_ms,
		eatStart: snapshot.eat_window_start_ms,
		eatEnd: snapshot.eat_window_end_ms,
		busy: calendar_busy_blocks,
	});

	const payload = {
		kind: "pre_eve",
		meal_id: snapshot.meal_id,
		plan_id: snapshot.plan_id,
		date: snapshot.date,
		slot: snapshot.slot,
		format: snapshot.format,
		cuisine: snapshot.cuisine,
		recipe_id: snapshot.recipe_id,
		weather,
		calendar,
		// Track C — calendar conflict surface (consumed by next-day UI).
		calendar_busy_blocks_json: conflict.intersecting_blocks,
		cook_window_conflict: conflict.cook_window_conflict ? 1 : 0,
		eat_window_conflict: conflict.eat_window_conflict ? 1 : 0,
		cook_window_tight: conflict.cook_window_tight ? 1 : 0,
		conflict_summary: conflict.summary,
		// Leftover hint — Phase 2 will swap in real plan_read_batches data.
		leftover_hint: { available_components_placeholder: true },
		equipment_readiness: snapshot.equipment.map(e => ({
			equipment: e,
			ready: true,
		})),
		generated_at_ms: deps.now_ms,
	};

	const briefing: BriefingRow = {
		briefing_id: generateBriefingId(deps.now_ms),
		household_id: snapshot.household_id,
		plan_id: snapshot.plan_id,
		meal_id: snapshot.meal_id,
		kind: "pre_eve",
		payload_json: JSON.stringify(payload),
		created_at: new Date(deps.now_ms).toISOString(),
	};

	// Track C — emit a heads-up notification per adult when a conflict was
	// detected. Lets MemberAgent / push-fanout see the issue the night
	// before, when there's still time to reshuffle the calendar. When no
	// adult ids were passed at /init (the common path — PlanAgent spawns
	// MealAgent without member context), still emit ONE household-level
	// notification with member_id=null so the conflict isn't silently dropped.
	const notifications: NotificationRow[] = [];
	if (conflict.cook_window_conflict || conflict.eat_window_conflict) {
		const fanout = deps.adults.adult_member_ids
			.map(id => (id || "").trim())
			.filter(id => id.length > 0);
		const targets = fanout.length > 0 ? fanout : [null as unknown as string];
		for (const member_id of targets) {
			notifications.push({
				notification_id: generateNotificationId(deps.now_ms),
				household_id: snapshot.household_id,
				member_id: member_id ?? null,
				source_agent_kind: "meal_agent",
				source_agent_id: snapshot.meal_id,
				kind: "calendar_conflict",
				title: `Calendar conflict tomorrow: ${snapshot.format || snapshot.slot}`,
				body: conflict.summary,
				payload_json: JSON.stringify({
					meal_id: snapshot.meal_id,
					date: snapshot.date,
					cook_window_conflict: conflict.cook_window_conflict,
					eat_window_conflict: conflict.eat_window_conflict,
					cook_window_tight: conflict.cook_window_tight,
					busy_blocks: conflict.intersecting_blocks,
				}),
				created_at: new Date(deps.now_ms).toISOString(),
			});
		}
	}

	// day_of fires at eat_window_start_ms - 12h.
	const next = snapshot.eat_window_start_ms - 12 * 60 * 60 * 1000;

	return {
		phase: "pre_eve",
		briefings: [briefing],
		notifications,
		cook_sessions: [],
		notes,
		next_alarm_at_ms: next > deps.now_ms ? next : deps.now_ms + 1_000,
	};
}

// ─── Track C — calendar-conflict helper (pure, in-module so we don't
// expand the module's export surface; the briefing payload is the
// contract consumers read). ────────────────────────────────────────────

interface CalendarConflictInput {
	cookStart: number;
	cookEnd: number;
	eatStart: number;
	eatEnd: number;
	busy: ReadonlyArray<CalendarBlock>;
}

interface CalendarConflictResult {
	cook_window_conflict: boolean;
	eat_window_conflict: boolean;
	cook_window_tight: boolean;
	intersecting_blocks: Array<{ start: string; end: string; title: string }>;
	summary: string;
}

function computeCalendarConflict(input: CalendarConflictInput): CalendarConflictResult {
	const { cookStart, cookEnd, eatStart, eatEnd, busy } = input;
	const intersecting: Array<{ start: string; end: string; title: string; startMs: number; endMs: number }> = [];

	for (const block of busy) {
		if (!block || block.busy === false) continue;
		const startMs = parseLocalIsoToMs(block.start);
		const endMs = parseLocalIsoToMs(block.end);
		if (startMs === null || endMs === null || endMs <= startMs) continue;
		const overlapsCook = startMs < cookEnd && endMs > cookStart;
		const overlapsEat = startMs < eatEnd && endMs > eatStart;
		if (overlapsCook || overlapsEat) {
			intersecting.push({
				start: block.start,
				end: block.end,
				title: block.title || "(busy)",
				startMs,
				endMs,
			});
		}
	}

	const cook_window_conflict = intersecting.some(b => b.startMs < cookEnd && b.endMs > cookStart);
	const eat_window_conflict = intersecting.some(b => b.startMs < eatEnd && b.endMs > eatStart);

	// Tight = any partial overlap with cook window AND largest free
	// contiguous slice < max(60min, half the window span).
	let cook_window_tight = false;
	if (cookEnd > cookStart) {
		const cookSpanMin = Math.round((cookEnd - cookStart) / 60_000);
		const tightThresholdMin = Math.max(60, Math.floor(cookSpanMin / 2));
		const overlapsClipped: Array<[number, number]> = intersecting
			.map(b => [Math.max(b.startMs, cookStart), Math.min(b.endMs, cookEnd)] as [number, number])
			.filter(([a, b]) => b > a)
			.sort((a, b) => a[0] - b[0]);
		const merged: Array<[number, number]> = [];
		for (const [a, b] of overlapsClipped) {
			if (!merged.length || a > merged[merged.length - 1][1]) {
				merged.push([a, b]);
			} else {
				merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], b);
			}
		}
		let largestFreeMin = 0;
		let cursor = cookStart;
		for (const [a, b] of merged) {
			if (a > cursor) {
				const dur = Math.round((a - cursor) / 60_000);
				if (dur > largestFreeMin) largestFreeMin = dur;
			}
			cursor = Math.max(cursor, b);
		}
		if (cursor < cookEnd) {
			const dur = Math.round((cookEnd - cursor) / 60_000);
			if (dur > largestFreeMin) largestFreeMin = dur;
		}
		// Only "tight" when there is partial overlap AND remaining free
		// time is below the threshold but > 0 (full conflict ≠ tight).
		const fullyBlocked = merged.length === 1 && merged[0][0] <= cookStart && merged[0][1] >= cookEnd;
		if (merged.length > 0 && !fullyBlocked && largestFreeMin > 0 && largestFreeMin < tightThresholdMin) {
			cook_window_tight = true;
		}
	}

	const summary = buildConflictSummary({
		cook_window_conflict,
		eat_window_conflict,
		cook_window_tight,
		intersecting: intersecting.map(({ start, end, title }) => ({ start, end, title })),
	});

	return {
		cook_window_conflict,
		eat_window_conflict,
		cook_window_tight,
		intersecting_blocks: intersecting.map(({ start, end, title }) => ({ start, end, title })),
		summary,
	};
}

function buildConflictSummary(args: {
	cook_window_conflict: boolean;
	eat_window_conflict: boolean;
	cook_window_tight: boolean;
	intersecting: Array<{ start: string; end: string; title: string }>;
}): string {
	if (!args.cook_window_conflict && !args.eat_window_conflict && !args.cook_window_tight) {
		return "no conflicts";
	}
	const parts: string[] = [];
	const sample = args.intersecting[0];
	const sampleClock = sample ? sample.start.slice(11, 16) : "";
	const sampleLabel = sample ? `${sampleClock} ${sample.title}` : "calendar event";
	if (args.cook_window_conflict) parts.push(`${sampleLabel} overlaps cook window`);
	if (args.eat_window_conflict) parts.push(`${sampleLabel} overlaps eat window`);
	if (args.cook_window_tight && !args.cook_window_conflict) {
		parts.push("cook window tight");
	}
	return parts.join("; ");
}

// Mirrors calendar-tools.parseToMinutes but returns an ms-precision number
// so we can compare against snapshot.{cook,eat}_window_*_ms (which were
// derived in defaultWindowsForSlot from the same local-clock convention —
// `Date.parse(\`${date}T00:00:00.000Z\`)` plus offsets).
function parseLocalIsoToMs(value: string): number | null {
	if (typeof value !== "string") return null;
	const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(value);
	if (!m) return null;
	const baseMs = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`);
	if (!Number.isFinite(baseMs)) return null;
	const hh = Number(m[4]);
	const mm = Number(m[5]);
	const ss = m[6] ? Number(m[6]) : 0;
	return baseMs + hh * 3_600_000 + mm * 60_000 + ss * 1_000;
}

// ─── day_of_entry ──────────────────────────────────────────────────────────

/**
 * Entry handler for `day_of` phase. Writes a briefing row including:
 *   - cook crew availability — caller passes adult_member_ids; we record
 *     them in payload (real presence comes from MemberAgent in Phase 2)
 *   - missed-prep flags — placeholder (PlanAgent integration in Phase 2)
 *   - shopping deltas — placeholder (PlanAgent integration in Phase 2)
 *
 * Schedules `cook_window` alarm at `cook_window_start_ms`.
 */
export async function day_of_entry(
	snapshot: MealSnapshot,
	deps: PhaseHandlerDeps,
): Promise<PhaseHandlerResult> {
	const notes: string[] = [];
	const payload = {
		kind: "day_of",
		meal_id: snapshot.meal_id,
		plan_id: snapshot.plan_id,
		date: snapshot.date,
		slot: snapshot.slot,
		cook_crew: deps.adults.adult_member_ids.map(id => ({
			member_id: id,
			availability: "unknown",  // Phase 2: pull from MemberAgent presence
		})),
		missed_prep: { items: [], placeholder: true },
		shopping_delta: { items: [], placeholder: true },
		generated_at_ms: deps.now_ms,
	};

	const briefing: BriefingRow = {
		briefing_id: generateBriefingId(deps.now_ms),
		household_id: snapshot.household_id,
		plan_id: snapshot.plan_id,
		meal_id: snapshot.meal_id,
		kind: "day_of",
		payload_json: JSON.stringify(payload),
		created_at: new Date(deps.now_ms).toISOString(),
	};

	const next = snapshot.cook_window_start_ms;

	return {
		phase: "day_of",
		briefings: [briefing],
		notifications: [],
		cook_sessions: [],
		notes,
		next_alarm_at_ms: next > deps.now_ms ? next : deps.now_ms + 1_000,
	};
}

// ─── cook_window_entry ─────────────────────────────────────────────────────

/**
 * Entry handler for `cook_window` phase. Side-effects:
 *   - claim equipment via the equipment-stub (Wave 7B-C will replace).
 *   - emit one `member_call` notification per adult member.
 *   - write current weather snapshot into a cook_window briefing row.
 *
 * Schedules `active_cook` alarm at `cook_window_start_ms + 30min` — if a
 * manual /start-cook arrives first, the agent re-schedules.
 */
export async function cook_window_entry(
	snapshot: MealSnapshot,
	deps: PhaseHandlerDeps,
	sink: AgentSqlSink,
): Promise<PhaseHandlerResult> {
	const notes: string[] = [];
	let weather: unknown = null;
	if (deps.location && typeof deps.location.lat === "number" && typeof deps.location.lng === "number") {
		try {
			const summary = await fetchWeatherForecast(
				{ lat: deps.location.lat, lng: deps.location.lng },
				snapshot.date,
				snapshot.date,
				{ timezone: deps.location.tz, city: deps.location.city },
			);
			weather = {
				pattern_summary: summary.pattern_summary,
				current_day: summary.forecast[0] || null,
			};
		} catch (err) {
			notes.push(`weather_fetch_failed:${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// ── Per-DO stub claim (legacy; preserved so existing callers see the
	//    same `equipment_claim` shape they always have). ───────────────────
	const equipment_claim = await claimEquipmentForMeal(sink, {
		meal_id: snapshot.meal_id,
		equipment: snapshot.equipment,
		claim_window: {
			start_ms: snapshot.cook_window_start_ms,
			end_ms: snapshot.cook_window_end_ms + 60 * 60 * 1000, // +1h cleanup buffer
		},
	});

	// ── Track D — real household-scoped equipment claim ─────────────────────
	//
	// The D1-backed equipment tracker (worker/src/mise-graph/equipment.ts)
	// is the canonical lock ledger across meals/tasks/shop runs. We claim
	// the meal's declared equipment for the cook+eat window so any other
	// meal trying to use the same oven (etc.) at the same time will see a
	// conflict and get rescheduled. Each missing equipment definition is
	// auto-created with a sensible default (exclusive ovens/skillets,
	// shared stovetop with capacity 4) so PlanAgent doesn't need to
	// pre-populate the household catalogue.
	let household_equipment_claim: PhaseHandlerResult["household_equipment_claim"];
	const householdEquipment = (snapshot.equipment || [])
		.map(e => (e || "").trim())
		.filter(e => e.length > 0);
	const claimStart = snapshot.cook_window_start_ms;
	const claimEnd = snapshot.eat_window_end_ms; // covers cook + eat window
	if (
		snapshot.household_id &&
		householdEquipment.length > 0 &&
		Number.isFinite(claimStart) &&
		Number.isFinite(claimEnd) &&
		claimEnd > claimStart
	) {
		try {
			for (const slug of householdEquipment) {
				try {
					await ensureEquipmentDefined(deps.env, snapshot.household_id, slug);
				} catch (err) {
					notes.push(`equipment_define_failed:${slug}:${err instanceof Error ? err.message : String(err)}`);
				}
			}
			const result = await claimEquipment(deps.env, {
				household_id: snapshot.household_id,
				all_or_nothing: true,
				claims: householdEquipment.map(slug => ({
					equipment_slug: slug,
					claim_for: { kind: "meal", id: snapshot.meal_id },
					start_ts: claimStart,
					end_ts: claimEnd,
					claimed_by: snapshot.meal_id,
				})),
			});
			household_equipment_claim = {
				ok: result.ok,
				granted: result.granted,
				conflicts: result.conflicts,
			};
			if (result.granted.length > 0) {
				notes.push(
					`claimed ${result.granted.length} item(s) of equipment: ${result.granted.map(g => g.equipment_slug).join(", ")}`,
				);
			}
			if (result.conflicts.length > 0) {
				notes.push(
					`equipment_conflict:${result.conflicts.length} item(s) busy: ${result.conflicts.map(c => c.requested.equipment_slug).join(", ")}`,
				);
			}
		} catch (err) {
			notes.push(`household_equipment_claim_failed:${err instanceof Error ? err.message : String(err)}`);
		}
	}

	const notifications: NotificationRow[] = [];
	for (const member_id of deps.adults.adult_member_ids) {
		const id = (member_id || "").trim();
		if (!id) continue;
		notifications.push({
			notification_id: generateNotificationId(deps.now_ms),
			household_id: snapshot.household_id,
			member_id: id,
			source_agent_kind: "meal_agent",
			source_agent_id: snapshot.meal_id,
			kind: "member_call",
			title: `Cook window open: ${snapshot.format || snapshot.slot}`,
			body: `Eat by ${new Date(snapshot.eat_window_start_ms).toISOString().slice(11, 16)} — ${snapshot.cuisine.join("/") || "tonight's meal"}`,
			payload_json: JSON.stringify({
				meal_id: snapshot.meal_id,
				cook_window_start_ms: snapshot.cook_window_start_ms,
				cook_window_end_ms: snapshot.cook_window_end_ms,
				eat_window_start_ms: snapshot.eat_window_start_ms,
				equipment: snapshot.equipment,
			}),
			created_at: new Date(deps.now_ms).toISOString(),
		});
	}

	// ── Track D — equipment-conflict member notification fan-out ───────────
	//
	// When the household-scoped claim found conflicts, surface them to each
	// adult so they can choose to reschedule or swap to the available
	// equipment. One notification per conflict per adult, kind=
	// "equipment_conflict" (distinct from the cook-window member_call so
	// downstream notification routing can prioritise it).
	if (household_equipment_claim && household_equipment_claim.conflicts.length > 0) {
		for (const member_id of deps.adults.adult_member_ids) {
			const id = (member_id || "").trim();
			if (!id) continue;
			for (const conflict of household_equipment_claim.conflicts) {
				const slug = conflict.requested.equipment_slug;
				const busyStart = conflict.conflicts_with[0]?.start_ts ?? conflict.requested.start_ts;
				const busyEnd = conflict.conflicts_with[0]?.end_ts ?? conflict.requested.end_ts;
				const busyClock = `${new Date(busyStart).toISOString().slice(11, 16)}–${new Date(busyEnd).toISOString().slice(11, 16)}`;
				const otherMeal = conflict.conflicts_with[0]?.claim_for.id ?? "another meal";
				notifications.push({
					notification_id: generateNotificationId(deps.now_ms),
					household_id: snapshot.household_id,
					member_id: id,
					source_agent_kind: "meal_agent",
					source_agent_id: snapshot.meal_id,
					kind: "equipment_conflict",
					title: `Equipment conflict: ${slug}`,
					body: `${slug} busy ${busyClock} with ${otherMeal} — start cook later or swap equipment`,
					payload_json: JSON.stringify({
						meal_id: snapshot.meal_id,
						equipment_slug: slug,
						busy_start_ms: busyStart,
						busy_end_ms: busyEnd,
						conflicting_claim_for: conflict.conflicts_with[0]?.claim_for ?? null,
					}),
					created_at: new Date(deps.now_ms).toISOString(),
				});
			}
		}
	}

	const payload = {
		kind: "cook_window",
		meal_id: snapshot.meal_id,
		plan_id: snapshot.plan_id,
		weather,
		equipment_claim_summary: {
			ok: equipment_claim.ok,
			claim_count: equipment_claim.claims.length,
			conflict_count: equipment_claim.conflicts.length,
			conflicts: equipment_claim.conflicts,
		},
		// Track D — household-scoped claim summary (the canonical view).
		household_equipment_claim_summary: household_equipment_claim
			? {
				ok: household_equipment_claim.ok,
				granted_count: household_equipment_claim.granted.length,
				conflict_count: household_equipment_claim.conflicts.length,
				granted_slugs: household_equipment_claim.granted.map(g => g.equipment_slug),
				conflicts: household_equipment_claim.conflicts.map(c => ({
					equipment_slug: c.requested.equipment_slug,
					requested_window: { start_ts: c.requested.start_ts, end_ts: c.requested.end_ts },
					conflicts_with: c.conflicts_with.map(cw => ({
						claim_for: cw.claim_for,
						start_ts: cw.start_ts,
						end_ts: cw.end_ts,
					})),
				})),
			}
			: null,
		notification_count: notifications.length,
		generated_at_ms: deps.now_ms,
	};

	const briefing: BriefingRow = {
		briefing_id: generateBriefingId(deps.now_ms),
		household_id: snapshot.household_id,
		plan_id: snapshot.plan_id,
		meal_id: snapshot.meal_id,
		kind: "cook_window",
		payload_json: JSON.stringify(payload),
		created_at: new Date(deps.now_ms).toISOString(),
	};

	// active_cook auto-fires 30min into the cook window if no manual start.
	const next = snapshot.cook_window_start_ms + 30 * 60 * 1000;

	return {
		phase: "cook_window",
		briefings: [briefing],
		notifications,
		cook_sessions: [],
		equipment_claim,
		household_equipment_claim,
		notes,
		next_alarm_at_ms: next > deps.now_ms ? next : deps.now_ms + 30 * 60 * 1000,
	};
}

// ─── active_cook_entry ─────────────────────────────────────────────────────

/**
 * Entry handler for `active_cook`. Writes the cook-session marker into
 * D1.mise_cook_sessions (and into the DO's local cook_session_marker
 * table). The 4h stale-timeout alarm is scheduled by the agent layer; we
 * report `next_alarm_at_ms` as `now + 4h` so the agent picks it up.
 *
 * Wave 8 will spawn a CookingLeadAgent here — for now we just persist a
 * marker row so PlanAgent can enumerate live sessions.
 */
export async function active_cook_entry(
	snapshot: MealSnapshot,
	deps: PhaseHandlerDeps,
): Promise<PhaseHandlerResult> {
	const cook_session_id = generateCookSessionId(deps.now_ms);
	const session: CookSessionRow = {
		cook_session_id,
		household_id: snapshot.household_id,
		plan_id: snapshot.plan_id,
		meal_id: snapshot.meal_id,
		state: "started",
		started_at: new Date(deps.now_ms).toISOString(),
		stale_at: null,
		ended_at: null,
		ended_reason: null,
		meta_json: JSON.stringify({
			adults: deps.adults.adult_member_ids,
			// Wave 8 foundation: MealAgent.runPhaseEntry now spawns a
			// CookingLeadAgent immediately after this handler returns. This
			// marker is preserved as the audit trail of the hand-off — the
			// brigade DO id is `cooking_lead:${cook_session_id}` (see
			// agents/base.ts cookingLeadAgentName).
			wave_8_handoff: "CookingLeadAgent spawned at active_cook entry",
		}),
	};

	const next = deps.now_ms + 4 * 60 * 60 * 1000; // 4h stale timeout

	return {
		phase: "active_cook",
		briefings: [],
		notifications: [],
		cook_sessions: [session],
		cook_session_marker: {
			cook_session_id,
			state: "started",
			meta_json: session.meta_json || undefined,
		},
		notes: [],
		next_alarm_at_ms: next,
	};
}

// ─── eaten_entry ───────────────────────────────────────────────────────────

/**
 * Entry handler for `eaten`. Captures eaten_at_ms in the cook_session_marker,
 * marks the D1 cook session row as `ended`. PlanAgent integration in Phase 2
 * will mark dependent meals' leftovers as available.
 *
 * Schedules `archived` alarm at `eaten_at_ms + 72h` (matches existing
 * shelf-life pattern).
 */
export async function eaten_entry(
	snapshot: MealSnapshot,
	deps: PhaseHandlerDeps,
	cook_session_id: string | null,
): Promise<PhaseHandlerResult> {
	const sessions: CookSessionRow[] = [];
	if (cook_session_id) {
		sessions.push({
			cook_session_id,
			household_id: snapshot.household_id,
			plan_id: snapshot.plan_id,
			meal_id: snapshot.meal_id,
			state: "ended",
			started_at: new Date(deps.now_ms - 60 * 60 * 1000).toISOString(),
			stale_at: null,
			ended_at: new Date(deps.now_ms).toISOString(),
			ended_reason: "eaten",
			meta_json: null,
		});
	}

	// ── Track D — release any household-scoped equipment claims this meal
	//    is still holding. Cooking is done; the oven, skillet, etc. are now
	//    free for the next meal/task to claim. Idempotent — if the meal
	//    never claimed anything (e.g. legacy cancel/repath) the count is 0.
	const notes: string[] = [];
	let releasedCount = 0;
	if (snapshot.household_id) {
		try {
			releasedCount = await releaseClaimsFor(deps.env, {
				household_id: snapshot.household_id,
				claim_for: { kind: "meal", id: snapshot.meal_id },
			});
		} catch (err) {
			notes.push(`equipment_release_failed:${err instanceof Error ? err.message : String(err)}`);
		}
	}

	const next = deps.now_ms + 72 * 60 * 60 * 1000;

	return {
		phase: "eaten",
		briefings: [],
		notifications: [],
		cook_sessions: sessions,
		cook_session_marker: cook_session_id
			? { cook_session_id, state: "ended", ended_reason: "eaten" }
			: undefined,
		equipment_released: { released: releasedCount },
		notes,
		next_alarm_at_ms: next,
	};
}

// ─── archived_entry ────────────────────────────────────────────────────────

/**
 * Entry handler for `archived` (terminal). Releases any equipment claims
 * still held by the meal. No alarm is scheduled.
 */
export async function archived_entry(
	snapshot: MealSnapshot,
	deps: PhaseHandlerDeps,
	sink: AgentSqlSink,
): Promise<PhaseHandlerResult> {
	void deps;
	const released = releaseEquipmentForMeal(sink, snapshot.meal_id);
	return {
		phase: "archived",
		briefings: [],
		notifications: [],
		cook_sessions: [],
		equipment_released: released,
		notes: [],
		next_alarm_at_ms: null,
	};
}

// ─── cancelled_entry (transition-to-archived with cancellation reason) ─────

/**
 * Special variant of archived_entry used when the meal was cancelled (vs.
 * naturally ending). Releases equipment AND emits a "cancelled" notification
 * to each adult so the cook crew knows to stand down.
 *
 * Returns the same `phase: "archived"` since the matrix only allows
 * `archived` as the terminal state — the reason field on the phase
 * transition row distinguishes "cancelled" from "completed".
 */
export async function cancelled_entry(
	snapshot: MealSnapshot,
	deps: PhaseHandlerDeps,
	sink: AgentSqlSink,
	reason: string,
): Promise<PhaseHandlerResult> {
	const released = releaseEquipmentForMeal(sink, snapshot.meal_id);
	// ── Track D — also release the canonical D1 household claims so any
	//    other meal/task waiting on this oven/skillet can immediately
	//    re-claim it. We sum both releases into the surface count so
	//    callers see the full impact. Failures are noted but don't block
	//    cancellation: legacy stub releases still happen above.
	const notes: string[] = [`cancelled: ${reason}`];
	let householdReleased = 0;
	if (snapshot.household_id) {
		try {
			householdReleased = await releaseClaimsFor(deps.env, {
				household_id: snapshot.household_id,
				claim_for: { kind: "meal", id: snapshot.meal_id },
			});
		} catch (err) {
			notes.push(`household_release_failed:${err instanceof Error ? err.message : String(err)}`);
		}
	}
	const notifications: NotificationRow[] = [];
	for (const member_id of deps.adults.adult_member_ids) {
		const id = (member_id || "").trim();
		if (!id) continue;
		notifications.push({
			notification_id: generateNotificationId(deps.now_ms),
			household_id: snapshot.household_id,
			member_id: id,
			source_agent_kind: "meal_agent",
			source_agent_id: snapshot.meal_id,
			kind: "meal_cancelled",
			title: `Meal cancelled: ${snapshot.format || snapshot.slot}`,
			body: reason,
			payload_json: JSON.stringify({ meal_id: snapshot.meal_id, reason }),
			created_at: new Date(deps.now_ms).toISOString(),
		});
	}
	return {
		phase: "archived",
		briefings: [],
		notifications,
		cook_sessions: [],
		equipment_released: { released: released.released + householdReleased },
		notes,
		next_alarm_at_ms: null,
	};
}

// ─── Snapshot-loading helper ───────────────────────────────────────────────

/**
 * Load a MealSnapshot from D1.mise_active_plans for the given meal_id.
 * Returns null if not found. Used by MealAgent.onInit to populate the
 * cached snapshot row in the DO's embedded SQLite.
 *
 * Pure async function — testable with a mock D1.
 */
export async function loadMealSnapshotFromActivePlan(
	env: MiseGraphEnv,
	plan_id: string,
	meal_id: string,
	overrides: Partial<MealSnapshot> = {},
): Promise<MealSnapshot | null> {
	const planRow = await env.DB.prepare(
		"SELECT plan_json, household_id FROM mise_active_plans WHERE plan_id = ? LIMIT 1",
	).bind(plan_id).first<{ plan_json: string; household_id: string | null }>();
	if (!planRow?.plan_json) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(planRow.plan_json);
	} catch {
		return null;
	}
	const meal = findMealInPlan(parsed, meal_id);
	if (!meal) return null;

	const date = String(meal.date || "");
	const slot = String(meal.slot || "dinner");
	const windows = defaultWindowsForSlot(date, slot);

	const equipment = extractEquipmentFromMeal(meal);

	const mealPeople = (meal as { people?: unknown }).people;
	return {
		meal_id,
		plan_id,
		household_id: planRow.household_id,
		date,
		slot,
		format: typeof meal.format === "string" ? meal.format : null,
		cuisine: Array.isArray(meal.cuisine) ? meal.cuisine.filter((c: unknown) => typeof c === "string") : [],
		recipe_id: extractRecipeId(meal),
		cook_window_start_ms: overrides.cook_window_start_ms ?? windows.cook_window_start_ms,
		cook_window_end_ms:   overrides.cook_window_end_ms ?? windows.cook_window_end_ms,
		eat_window_start_ms:  overrides.eat_window_start_ms ?? windows.eat_window_start_ms,
		eat_window_end_ms:    overrides.eat_window_end_ms ?? windows.eat_window_end_ms,
		equipment,
		people: typeof mealPeople === "number" && mealPeople > 0 ? mealPeople : null,
		...overrides,
	};
}

interface UnknownMeal {
	id?: string;
	date?: unknown;
	slot?: unknown;
	format?: unknown;
	cuisine?: unknown;
	source?: unknown;
	lineage?: unknown;
	components?: unknown;
	meta?: unknown;
}

function findMealInPlan(plan: unknown, meal_id: string): UnknownMeal | null {
	if (!plan || typeof plan !== "object") return null;
	const days = (plan as { meals_by_day?: unknown }).meals_by_day;
	if (!Array.isArray(days)) return null;
	for (const day of days) {
		if (!day || typeof day !== "object") continue;
		const meals = (day as { meals?: unknown }).meals;
		if (!Array.isArray(meals)) continue;
		for (const meal of meals) {
			if (meal && typeof meal === "object") {
				const id = (meal as { id?: unknown }).id;
				if (typeof id === "string" && id === meal_id) {
					return meal as UnknownMeal;
				}
			}
		}
	}
	// Also check breakfasts / snack_boxes if present.
	for (const key of ["breakfasts", "snack_boxes"] as const) {
		const arr = (plan as Record<string, unknown>)[key];
		if (Array.isArray(arr)) {
			for (const meal of arr) {
				if (meal && typeof meal === "object") {
					const id = (meal as { id?: unknown }).id;
					if (typeof id === "string" && id === meal_id) {
						return meal as UnknownMeal;
					}
				}
			}
		}
	}
	return null;
}

function extractEquipmentFromMeal(meal: UnknownMeal): string[] {
	const out = new Set<string>();
	const components = Array.isArray(meal.components) ? meal.components : [];
	for (const c of components) {
		if (c && typeof c === "object") {
			const eq = (c as { equipment?: unknown }).equipment;
			if (Array.isArray(eq)) {
				for (const e of eq) if (typeof e === "string" && e.trim()) out.add(e.trim());
			}
		}
	}
	const meta = meal.meta;
	if (meta && typeof meta === "object") {
		const eq = (meta as { equipment?: unknown }).equipment;
		if (Array.isArray(eq)) {
			for (const e of eq) if (typeof e === "string" && e.trim()) out.add(e.trim());
		}
	}
	return Array.from(out);
}

function extractRecipeId(meal: UnknownMeal): string | null {
	const lineage = meal.lineage;
	if (Array.isArray(lineage) && lineage.length > 0) {
		const first = lineage[0] as { recipe_id?: unknown } | undefined;
		if (first && typeof first.recipe_id === "string") return first.recipe_id;
	}
	const source = meal.source;
	if (typeof source === "string" && source.startsWith("recipe:")) return source;
	return null;
}
