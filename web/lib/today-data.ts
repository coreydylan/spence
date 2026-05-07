/**
 * Server-side data assembler for /today.
 *
 * Fetches in parallel:
 *   - household_read_brief (today's morning brief: weather + calendar + plan_health + suggestions + onboarding_question)
 *   - plan_list           (the active plan id we'll thread through plan_read_meal calls)
 *   - chef_status_check   (used to surface the day's question + spot tier-0 incomplete)
 *
 * Then sequentially:
 *   - plan_read_meal for tonight's dinner (if a plan exists)
 *   - plan_read_meal × N for the next 2-3 days' dinners ("coming up")
 *   - plan_read_grievances filtered to preference (soft amber warnings)
 *
 * Returns a single TodayData object the page renders straight off of.
 */

import {
  mcp,
  type ChefStatus,
  type CalendarWindow,
  type DailyBriefSuggestion,
  type Grievance,
  type McpContext,
  type MorningBrief,
  type PlanMeal,
  type WeatherSummary,
} from "./mcp";
import { addDays, todayIso } from "./dates";

export interface UpcomingMeal {
  date: string;
  meal: PlanMeal | null;
  conflict: boolean;
}

export interface TodayData {
  date: string;
  household_id: string;
  /** The brief, or null when none has been generated yet (cron hasn't fired). */
  brief: MorningBrief | null;
  /** Active plan id when one exists. */
  plan_id: string | null;
  /** Tonight's dinner — null if no plan or slot empty. */
  tonight: PlanMeal | null;
  tonight_calendar_conflict: boolean;
  upcoming: UpcomingMeal[];
  /** Soft preference grievances scoped to upcoming meals. */
  preference_warnings: Grievance[];
  /** Latest chef status. Drives the "Question for you" callout. */
  chef_status: ChefStatus | null;
  /** True when the household needs onboarding redirect. */
  needs_onboarding: boolean;
  /** Errors collected per fetch — we never crash the page. */
  fetch_errors: string[];
}

export interface LoadTodayOptions {
  /** Override "today" — useful for previewing or tests. */
  today?: string;
  /** How many days of "coming up" cards to render. Default 3. */
  upcoming_days?: number;
}

export async function loadTodayData(
  ctx: McpContext,
  options: LoadTodayOptions = {},
): Promise<TodayData> {
  const date = options.today ?? todayIso();
  const upcomingDays = options.upcoming_days ?? 3;
  const errors: string[] = [];

  // 1. Parallel: brief + plans + chef_status_check.
  const [briefRes, plansRes, statusRes] = await Promise.allSettled([
    mcp("household_read_brief", { household_id: ctx.household_id, date }, ctx),
    mcp("plan_list", { household_id: ctx.household_id }, ctx),
    mcp("chef_status_check", { household_id: ctx.household_id }, ctx),
  ]);

  let brief: MorningBrief | null = null;
  if (briefRes.status === "fulfilled") {
    const r = briefRes.value;
    if (r.ok) brief = r.brief;
  } else {
    errors.push(`brief: ${briefRes.reason}`);
  }

  let plan_id: string | null = null;
  if (plansRes.status === "fulfilled") {
    const sorted = [...plansRes.value.plans].sort((a, b) =>
      (b.updated_at || "").localeCompare(a.updated_at || ""),
    );
    plan_id = sorted[0]?.plan_id ?? null;
  } else {
    errors.push(`plan_list: ${plansRes.reason}`);
  }

  let chef_status: ChefStatus | null = null;
  if (statusRes.status === "fulfilled") {
    chef_status = statusRes.value;
  } else {
    errors.push(`chef_status_check: ${statusRes.reason}`);
  }

  const needs_onboarding = !!(
    chef_status &&
    !chef_status.onboarding.tier_0_done &&
    chef_status.onboarding.blocked_actions.length > 0
  );

  // 2. Sequential: read meals for today + upcoming days.
  let tonight: PlanMeal | null = null;
  let tonight_calendar_conflict = false;
  const upcoming: UpcomingMeal[] = [];

  if (plan_id) {
    const datesToRead = [date];
    for (let i = 1; i <= upcomingDays; i += 1) datesToRead.push(addDays(date, i));

    const reads = await Promise.allSettled(
      datesToRead.map((d) =>
        mcp("plan_read_meal", { plan_id: plan_id!, slot: { date: d, slot: "dinner" } }, ctx),
      ),
    );

    reads.forEach((res, idx) => {
      const d = datesToRead[idx];
      const meal = res.status === "fulfilled" ? res.value.meal ?? null : null;
      if (res.status === "rejected") errors.push(`meal_${d}: ${res.reason}`);
      const conflict = !!(brief && hasCalendarConflict(brief.calendar, d, meal));
      if (idx === 0) {
        tonight = meal;
        tonight_calendar_conflict = conflict;
      } else {
        upcoming.push({ date: d, meal, conflict });
      }
    });
  }

  // 3. Preference grievances (soft warnings).
  let preference_warnings: Grievance[] = [];
  if (plan_id) {
    try {
      const grievances = await mcp(
        "plan_read_grievances",
        { plan_id, severity: "preference" },
        ctx,
      );
      preference_warnings = grievances.grievances.slice(0, 4);
    } catch (err) {
      errors.push(`grievances: ${String(err)}`);
    }
  }

  return {
    date,
    household_id: ctx.household_id,
    brief,
    plan_id,
    tonight,
    tonight_calendar_conflict,
    upcoming,
    preference_warnings,
    chef_status,
    needs_onboarding,
    fetch_errors: errors,
  };
}

/** Check whether a calendar event on `date` overlaps the meal's start window. */
function hasCalendarConflict(
  calendar: CalendarWindow[],
  date: string,
  meal: PlanMeal | null,
): boolean {
  if (!meal) return false;
  const win = calendar.find((c) => c.date === date);
  if (!win) return false;
  // Heuristic: any busy block between 17:00 and 20:00 counts as a dinner-time conflict.
  return win.busy_blocks.some((b) => {
    const start = parseTimeFromIso(b.start);
    const end = parseTimeFromIso(b.end);
    return overlapsWindow(start, end, 17 * 60, 20 * 60);
  });
}

function parseTimeFromIso(iso: string | undefined): number {
  if (!iso) return 0;
  // Either HH:MM or full ISO timestamp
  const hhmm = /T(\d{2}):(\d{2})/.exec(iso) || /^(\d{1,2}):(\d{2})/.exec(iso);
  if (!hhmm) return 0;
  return Number(hhmm[1]) * 60 + Number(hhmm[2]);
}

function overlapsWindow(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && aEnd > bStart;
}

/** Top-level pattern summary derived from the brief's weather. */
export function weatherStripFields(weather: WeatherSummary | null, date: string): {
  conditions: string;
  high: number | null;
  low: number | null;
  pattern: string;
} | null {
  if (!weather) return null;
  const day = weather.forecast.find((f) => f.date === date) ?? weather.forecast[0];
  if (!day) return null;
  return {
    conditions: day.conditions,
    high: day.high_f ?? null,
    low: day.low_f ?? null,
    pattern: weather.pattern_summary || "",
  };
}

/** Pull up top suggestions to render as small chips. */
export function topSuggestions(
  brief: MorningBrief | null,
  limit = 3,
): DailyBriefSuggestion[] {
  if (!brief) return [];
  return brief.suggestions.slice(0, limit);
}
