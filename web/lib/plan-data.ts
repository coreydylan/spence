/**
 * Server-side assembler for /plan.
 *
 * Fetches:
 *   - plan_list: pick the most recently updated active plan
 *   - plan_read_recent_meals (n=50) for {id,date,slot,title,format,cuisine}
 *   - plan_read_meal per dinner slot for full meta (active_minutes, start)
 *   - household_read_brief for weather glyph + calendar conflict markers
 *   - plan_read_grievances (preference) for soft warnings
 */

import {
  mcp,
  mcp_call_any,
  type CalendarWindow,
  type Grievance,
  type McpContext,
  type MorningBrief,
  type PlanMeal,
  type WeatherSummary,
} from "./mcp";
import { addDays, todayIso } from "./dates";

export interface WeekRowData {
  date: string;
  meal: PlanMeal | null;
  weatherGlyph?: string;
  conflict: boolean;
  isToday: boolean;
}

export interface PlanData {
  plan_id: string | null;
  start_date: string;
  end_date: string;
  rows: WeekRowData[];
  preference_warnings: Grievance[];
  brief: MorningBrief | null;
  fetch_errors: string[];
}

interface RecentMeal {
  id: string;
  date: string;
  slot: "breakfast" | "lunch" | "dinner" | "snack";
  title: string;
  format?: string;
  cuisine?: string[];
}

export async function loadPlanData(
  ctx: McpContext,
  options: { today?: string; window_days?: number } = {},
): Promise<PlanData> {
  const today = options.today ?? todayIso();
  const window = options.window_days ?? 7;
  const errors: string[] = [];

  let plan_id: string | null = null;
  try {
    const list = await mcp("plan_list", { household_id: ctx.household_id }, ctx);
    const sorted = [...list.plans].sort((a, b) =>
      (b.updated_at || "").localeCompare(a.updated_at || ""),
    );
    plan_id = sorted[0]?.plan_id ?? null;
  } catch (err) {
    errors.push(`plan_list: ${String(err)}`);
  }

  // Build the date range. Anchor on today; show today + (window-1) days forward.
  // Fall back to a synthetic week even when no plan exists so the UI is alive.
  const start_date = today;
  const end_date = addDays(today, window - 1);
  const dates: string[] = [];
  for (let i = 0; i < window; i += 1) dates.push(addDays(today, i));

  // Brief (weather + calendar).
  let brief: MorningBrief | null = null;
  try {
    const r = await mcp(
      "household_read_brief",
      { household_id: ctx.household_id, date: today },
      ctx,
    );
    if (r.ok) brief = r.brief;
  } catch (err) {
    errors.push(`brief: ${String(err)}`);
  }

  // Recent meals for stub — id/date/slot/title/format/cuisine.
  const dinnersByDate = new Map<string, RecentMeal>();
  if (plan_id) {
    try {
      const recent = (await mcp_call_any(
        "plan_read_recent_meals",
        { plan_id, n: 50 },
        ctx,
      )) as { meals?: RecentMeal[] };
      for (const m of recent.meals ?? []) {
        if (m.slot === "dinner" && dates.includes(m.date)) {
          dinnersByDate.set(m.date, m);
        }
      }
    } catch (err) {
      errors.push(`recent_meals: ${String(err)}`);
    }
  }

  // Hydrate full meal records for each filled dinner (active minutes, start time).
  const reads = await Promise.allSettled(
    Array.from(dinnersByDate.entries()).map(async ([date, stub]) => {
      try {
        const r = await mcp(
          "plan_read_meal",
          { plan_id: plan_id!, slot: { date, slot: "dinner" } },
          ctx,
        );
        return { date, meal: r.meal };
      } catch {
        return {
          date,
          meal: {
            id: stub.id,
            title: stub.title,
            format: stub.format,
            cuisine: stub.cuisine,
            date,
            slot: "dinner" as const,
          } as PlanMeal,
        };
      }
    }),
  );

  const fullMealsByDate = new Map<string, PlanMeal>();
  for (const r of reads) {
    if (r.status === "fulfilled" && r.value.meal) {
      fullMealsByDate.set(r.value.date, r.value.meal);
    } else if (r.status === "rejected") {
      errors.push(`plan_read_meal: ${String(r.reason)}`);
    }
  }

  // Build row data.
  const rows: WeekRowData[] = dates.map((date) => ({
    date,
    meal: fullMealsByDate.get(date) ?? null,
    weatherGlyph: weatherGlyph(brief?.weather ?? null, date),
    conflict: hasCalendarConflict(brief?.calendar ?? [], date),
    isToday: date === today,
  }));

  // Preference grievances scoped to dates in the window.
  let preference_warnings: Grievance[] = [];
  if (plan_id) {
    try {
      const g = await mcp(
        "plan_read_grievances",
        { plan_id, severity: "preference" },
        ctx,
      );
      preference_warnings = g.grievances
        .filter((x) => !x.date || dates.includes(x.date))
        .slice(0, 6);
    } catch (err) {
      errors.push(`grievances: ${String(err)}`);
    }
  }

  return {
    plan_id,
    start_date,
    end_date,
    rows,
    preference_warnings,
    brief,
    fetch_errors: errors,
  };
}

function weatherGlyph(weather: WeatherSummary | null, date: string): string | undefined {
  if (!weather) return undefined;
  const day = weather.forecast.find((f) => f.date === date);
  if (!day) return undefined;
  const c = day.conditions.toLowerCase();
  if (c.includes("storm")) return "⛈";
  if (c.includes("rain") || c.includes("drizzle")) return "🌧";
  if (c.includes("snow")) return "❄";
  if (c.includes("fog")) return "🌫";
  if (c.includes("sun") || c.includes("clear")) return "☀";
  if (c.includes("cloud") || c.includes("overcast") || c.includes("partly")) return "☁";
  return undefined;
}

function hasCalendarConflict(calendar: CalendarWindow[], date: string): boolean {
  const win = calendar.find((c) => c.date === date);
  if (!win) return false;
  return win.busy_blocks.some((b) => {
    const s = parseTimeFromIso(b.start);
    const e = parseTimeFromIso(b.end);
    return s < 20 * 60 && e > 17 * 60;
  });
}

function parseTimeFromIso(iso: string | undefined): number {
  if (!iso) return 0;
  const m = /T(\d{2}):(\d{2})/.exec(iso) || /^(\d{1,2}):(\d{2})/.exec(iso);
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}
