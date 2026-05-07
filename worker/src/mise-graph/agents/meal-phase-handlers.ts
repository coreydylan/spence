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
import { readCalendarWindows } from "../calendar-tools";
import { fetchWeatherForecast } from "../weather-tools";
import type { AgentSqlSink } from "./base";
import {
	claimEquipmentForMeal,
	releaseEquipmentForMeal,
	type ClaimEquipmentResult,
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
	member_id: string;
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
	if (snapshot.household_id) {
		try {
			const windows = await readCalendarWindows(
				deps.env,
				snapshot.household_id,
				snapshot.date,
				snapshot.date,
			);
			calendar = windows[0] || null;
		} catch (err) {
			notes.push(`calendar_read_failed:${err instanceof Error ? err.message : String(err)}`);
		}
	}

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

	// day_of fires at eat_window_start_ms - 12h.
	const next = snapshot.eat_window_start_ms - 12 * 60 * 60 * 1000;

	return {
		phase: "pre_eve",
		briefings: [briefing],
		notifications: [],
		cook_sessions: [],
		notes,
		next_alarm_at_ms: next > deps.now_ms ? next : deps.now_ms + 1_000,
	};
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

	// Wave 7B-C will replace with real equipment tracker.
	const equipment_claim = await claimEquipmentForMeal(sink, {
		meal_id: snapshot.meal_id,
		equipment: snapshot.equipment,
		claim_window: {
			start_ms: snapshot.cook_window_start_ms,
			end_ms: snapshot.cook_window_end_ms + 60 * 60 * 1000, // +1h cleanup buffer
		},
	});

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

	const next = deps.now_ms + 72 * 60 * 60 * 1000;

	return {
		phase: "eaten",
		briefings: [],
		notifications: [],
		cook_sessions: sessions,
		cook_session_marker: cook_session_id
			? { cook_session_id, state: "ended", ended_reason: "eaten" }
			: undefined,
		notes: [],
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
		equipment_released: released,
		notes: [`cancelled: ${reason}`],
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
