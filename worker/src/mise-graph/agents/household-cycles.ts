// Wave 7B Track B — HouseholdAgent morning brief logic, extracted as pure
// functions so they can be unit-tested without booting the Agents SDK.
//
// The HouseholdAgent class wraps these with `this.env`, `this.state`, alarm
// scheduling, and trace integration. Everything here is `(env, args) => ...`
// so the same code path runs identically in node-side tests and inside the DO.

import type { MiseGraphEnv } from "../types";
import { listActivePlans, loadActivePlan } from "../active-plans";
import { readCalendarWindows, type CalendarWindow } from "../calendar-tools";
import { fetchWeatherForecast, type WeatherSummary } from "../weather-tools";
import { runHardCritics, runWarningCritics } from "../critics";
import type { MisePlanTask, MiseWeeklyPlanDraft } from "../planner";
import { generateAgentId } from "./base";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PlanHealthSnapshot {
	plan_id: string;
	hard_grievance_count: number;
	warning_grievance_count: number;
	missed_prep_today: string[];          // task titles whose scheduled_date < today and not marked done
	headline_issue: string | null;
}

export interface DailyBriefSuggestion {
	kind: "shop_today" | "prep_today" | "expiring_soon" | "tight_window" | "missed_prep";
	message: string;
	plan_id?: string;
}

export interface MorningBriefResult {
	id: string;
	household_id: string;
	for_date: string;                      // YYYY-MM-DD
	weather: WeatherSummary | null;
	calendar: CalendarWindow[];
	plan_health: PlanHealthSnapshot[];
	suggestions: DailyBriefSuggestion[];
	created_at_ms: number;
}

export interface BriefLocationOverride {
	lat: number;
	lng: number;
	city?: string;
	tz?: string;
}

export interface ComputeMorningBriefOptions {
	now?: Date;                            // override for tests
	location?: BriefLocationOverride;      // when household profile lacks lat/lng (which it does today)
	fetch_impl?: typeof fetch;             // for weather, in case tests mock
	skip_weather?: boolean;                // unit tests don't want the network call
}

// ─── Pure helpers ──────────────────────────────────────────────────────────

/**
 * Compute the local-7am Date for a given household. Wave 7 doesn't yet have
 * lat/lng on the household profile, so we approximate by using the supplied
 * `now` (caller's clock) and rolling forward to the next 14:00 UTC = 7am
 * Pacific. Phase 2 wiring + Wave 7C lat/lng will refine this. Always
 * returns a Date strictly in the future.
 */
export function nextLocal7am(now: Date = new Date()): Date {
	const target = new Date(now.getTime());
	target.setUTCHours(14, 0, 0, 0);
	if (target.getTime() <= now.getTime()) {
		target.setUTCDate(target.getUTCDate() + 1);
	}
	return target;
}

/** YYYY-MM-DD slice from a Date. */
export function isoDate(d: Date): string {
	return d.toISOString().slice(0, 10);
}

/** "today + N days" YYYY-MM-DD list (inclusive of today). */
export function nextNDates(now: Date, n: number): string[] {
	const out: string[] = [];
	const start = new Date(now.getTime());
	start.setUTCHours(0, 0, 0, 0);
	for (let i = 0; i < n; i++) {
		const d = new Date(start.getTime());
		d.setUTCDate(d.getUTCDate() + i);
		out.push(isoDate(d));
	}
	return out;
}

// ─── Plan-health derivation (pure) ─────────────────────────────────────────

export function buildPlanHealthSnapshot(plan: MiseWeeklyPlanDraft, today: string): PlanHealthSnapshot {
	const hard = runHardCritics(plan, {});
	const warning = runWarningCritics(plan, { now: today });

	// Missed prep: any task with scheduled_date < today is treated as missed
	// for the brief (Wave 7B doesn't have a "completed" flag yet — the
	// CookAgent transitioning to `completed` will eventually populate that).
	const missed: string[] = [];
	for (const task of (plan.prep_tasks || []) as MisePlanTask[]) {
		const scheduled = task.scheduled_date;
		if (typeof scheduled !== "string" || scheduled.length === 0) continue;
		if (scheduled < today) {
			const title = task.title || "prep task";
			if (!missed.includes(title)) missed.push(title);
			if (missed.length >= 5) break;
		}
	}

	const headline = hard[0]?.message || warning[0]?.message || null;

	return {
		plan_id: plan.id,
		hard_grievance_count: hard.length,
		warning_grievance_count: warning.length,
		missed_prep_today: missed,
		headline_issue: headline,
	};
}

export function buildSuggestions(
	plan_health: PlanHealthSnapshot[],
	calendar: CalendarWindow[],
	for_date: string,
): DailyBriefSuggestion[] {
	const out: DailyBriefSuggestion[] = [];

	for (const h of plan_health) {
		if (h.missed_prep_today.length > 0) {
			out.push({
				kind: "missed_prep",
				message: `${h.missed_prep_today.length} prep task${h.missed_prep_today.length === 1 ? "" : "s"} missed: ${h.missed_prep_today.join(", ")}`,
				plan_id: h.plan_id,
			});
		}
		if (h.hard_grievance_count > 0 && h.headline_issue) {
			out.push({
				kind: "tight_window",
				message: `Plan has ${h.hard_grievance_count} hard issue${h.hard_grievance_count === 1 ? "" : "s"}; headline: ${h.headline_issue}`,
				plan_id: h.plan_id,
			});
		}
	}

	const today = calendar.find(w => w.date === for_date);
	if (today && today.cook_window && (today.cook_window.duration_min ?? 0) < 45) {
		out.push({
			kind: "tight_window",
			message: `Cook window today is only ${today.cook_window.duration_min ?? 0} min — pick something fast`,
		});
	}

	return out;
}

// ─── Compute (impure — calls D1 + weather) ────────────────────────────────

export async function computeMorningBrief(
	env: MiseGraphEnv,
	household_id: string,
	options: ComputeMorningBriefOptions = {},
): Promise<MorningBriefResult> {
	const now = options.now || new Date();
	const for_date = isoDate(now);
	const horizon = nextNDates(now, 3);
	const last = horizon[horizon.length - 1];

	// Calendar (next 3 days).
	let calendar: CalendarWindow[] = [];
	try {
		calendar = await readCalendarWindows(env, household_id, for_date, last);
	} catch {
		calendar = [];
	}

	// Weather (best effort — needs lat/lng).
	let weather: WeatherSummary | null = null;
	if (!options.skip_weather && options.location) {
		try {
			weather = await fetchWeatherForecast(
				{ lat: options.location.lat, lng: options.location.lng },
				for_date,
				last,
				{
					timezone: options.location.tz,
					city: options.location.city,
					fetch_impl: options.fetch_impl,
				},
			);
		} catch {
			weather = null;
		}
	}

	// Plan health for every active plan that touches today.
	const plan_health: PlanHealthSnapshot[] = [];
	let summaries: Awaited<ReturnType<typeof listActivePlans>> = [];
	try {
		summaries = await listActivePlans(env, household_id);
	} catch {
		summaries = [];
	}
	for (const s of summaries) {
		const plan = await loadActivePlan(env, s.plan_id);
		if (!plan) continue;
		// Only include plans whose date range covers today (best-effort: meals_by_day dates).
		const planTouchesToday = (plan.meals_by_day || []).some(d => d.date === for_date)
			|| (plan.breakfasts || []).some(b => b.date === for_date)
			|| (plan.shop_runs || []).some(r => r.date === for_date)
			|| (plan.prep_tasks || []).some(t => t.scheduled_date === for_date);
		if (!planTouchesToday) continue;
		plan_health.push(buildPlanHealthSnapshot(plan, for_date));
	}

	const suggestions = buildSuggestions(plan_health, calendar, for_date);

	return {
		id: generateAgentId("brief"),
		household_id,
		for_date,
		weather,
		calendar,
		plan_health,
		suggestions,
		created_at_ms: now.getTime(),
	};
}

// ─── Persistence ────────────────────────────────────────────────────────────
//
// The D1 row mirrors the in-memory MorningBriefResult, with JSON columns for
// the nested structures. UNIQUE INDEX on (household_id, for_date) makes
// re-running the brief on the same day overwrite the previous row.

export interface PersistedBriefRow {
	id: string;
	household_id: string;
	for_date: string;
	created_at_ms: number;
}

export async function persistMorningBrief(
	env: MiseGraphEnv,
	brief: MorningBriefResult,
): Promise<PersistedBriefRow> {
	const now = brief.created_at_ms;
	await env.DB.prepare(
		`INSERT INTO mise_household_agent_briefs
			(id, household_id, for_date,
			 weather_summary_json, calendar_windows_json,
			 plan_health_json, suggestions_json,
			 brief_id, created_at_ms, updated_at_ms)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(household_id, for_date) DO UPDATE SET
			weather_summary_json = excluded.weather_summary_json,
			calendar_windows_json = excluded.calendar_windows_json,
			plan_health_json = excluded.plan_health_json,
			suggestions_json = excluded.suggestions_json,
			updated_at_ms = excluded.updated_at_ms`,
	).bind(
		brief.id,
		brief.household_id,
		brief.for_date,
		brief.weather ? JSON.stringify(brief.weather) : null,
		JSON.stringify(brief.calendar),
		JSON.stringify(brief.plan_health),
		JSON.stringify(brief.suggestions),
		null,
		now,
		now,
	).run();

	return {
		id: brief.id,
		household_id: brief.household_id,
		for_date: brief.for_date,
		created_at_ms: now,
	};
}

export async function loadLatestBrief(
	env: MiseGraphEnv,
	household_id: string,
): Promise<MorningBriefResult | null> {
	let row: {
		id: string;
		household_id: string;
		for_date: string;
		weather_summary_json: string | null;
		calendar_windows_json: string | null;
		plan_health_json: string | null;
		suggestions_json: string | null;
		created_at_ms: number;
	} | null = null;
	try {
		row = await env.DB.prepare(
			`SELECT id, household_id, for_date,
			        weather_summary_json, calendar_windows_json,
			        plan_health_json, suggestions_json, created_at_ms
			 FROM mise_household_agent_briefs
			 WHERE household_id = ?
			 ORDER BY created_at_ms DESC
			 LIMIT 1`,
		).bind(household_id).first();
	} catch {
		row = null;
	}
	if (!row) return null;
	return {
		id: row.id,
		household_id: row.household_id,
		for_date: row.for_date,
		weather: row.weather_summary_json ? safeParseJson<WeatherSummary>(row.weather_summary_json) : null,
		calendar: row.calendar_windows_json ? safeParseJson<CalendarWindow[]>(row.calendar_windows_json) ?? [] : [],
		plan_health: row.plan_health_json ? safeParseJson<PlanHealthSnapshot[]>(row.plan_health_json) ?? [] : [],
		suggestions: row.suggestions_json ? safeParseJson<DailyBriefSuggestion[]>(row.suggestions_json) ?? [] : [],
		created_at_ms: row.created_at_ms,
	};
}

function safeParseJson<T>(value: string): T | null {
	try {
		return JSON.parse(value) as T;
	} catch {
		return null;
	}
}
