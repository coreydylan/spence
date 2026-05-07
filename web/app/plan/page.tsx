import * as React from "react";
import Link from "next/link";
import { headers } from "next/headers";
import { getSessionFromHeaders } from "@/lib/auth";
import { loadPlanData } from "@/lib/plan-data";
import { addDays, todayIso, weekOfLabel } from "@/lib/dates";
import { PreferenceWarning } from "@/components/meal/preference-warning";
import { WeekRow } from "./components/week-row";
import { AddDayCta } from "./components/add-day-cta";

export const dynamic = "force-dynamic";

interface SearchParams {
  start?: string;
}

/**
 * /plan — week view.
 *
 * Server Component. Fetches plan_list + plan_read_recent_meals +
 * household_read_brief, then hydrates each dinner via plan_read_meal.
 * Renders a vertical list of rows (one per day) with weather glyph,
 * meal title, calendar-conflict badge, and a long-press options sheet.
 *
 * `?start=YYYY-MM-DD` lets the prev/next nav scroll the window without
 * a client component.
 */
export default async function PlanPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const h = await headers();
  const session = await getSessionFromHeaders(h);

  const params = (await searchParams) ?? {};
  const start = params.start && /^\d{4}-\d{2}-\d{2}$/.test(params.start)
    ? params.start
    : todayIso();

  const data = await loadPlanData(
    {
      household_id: session.household_id,
      caller_kind: "human",
      caller_id: "spence-web-plan",
    },
    { today: start, window_days: 7 },
  );

  const prevStart = addDays(start, -7);
  const nextStart = addDays(start, 7);
  const lastDate = data.rows[data.rows.length - 1]?.date ?? start;

  return (
    <div className="flex flex-col gap-8 animate-fade-up">
      {/* ── Header with navigation ────────────────────────────────── */}
      <header className="flex items-end justify-between gap-3">
        <h1 className="font-serif text-3xl md:text-4xl text-ink leading-tight">
          {weekOfLabel(start)}
        </h1>
        <nav className="flex items-center gap-1">
          <Link
            href={`/plan?start=${prevStart}`}
            className="h-9 w-9 grid place-items-center rounded-full border border-ink/15 text-ink-soft hover:text-ink hover:bg-cream-deep"
            aria-label="Previous week"
          >
            ‹
          </Link>
          <Link
            href={`/plan?start=${nextStart}`}
            className="h-9 w-9 grid place-items-center rounded-full border border-ink/15 text-ink-soft hover:text-ink hover:bg-cream-deep"
            aria-label="Next week"
          >
            ›
          </Link>
        </nav>
      </header>

      {/* ── Day list ──────────────────────────────────────────────── */}
      <ul className="flex flex-col gap-3" data-testid="plan-week-list">
        {data.rows.map((row) => (
          <li key={row.date}>
            <WeekRow
              date={row.date}
              meal={row.meal}
              weatherGlyph={row.weatherGlyph}
              conflict={row.conflict}
              isToday={row.isToday}
            />
          </li>
        ))}
      </ul>

      <AddDayCta nextDate={addDays(lastDate, 1)} />

      {/* ── Preference warnings ──────────────────────────────────── */}
      {data.preference_warnings.length > 0 && (
        <section className="flex flex-col gap-3 mt-2" aria-label="Heads up">
          <h2 className="text-xs uppercase tracking-[0.18em] text-ink-soft font-semibold">
            Heads up
          </h2>
          {data.preference_warnings.map((g, i) => (
            <PreferenceWarning key={`${g.code}-${i}`} message={g.message} />
          ))}
        </section>
      )}

      {/* ── Empty plan affordance ────────────────────────────────── */}
      {!data.plan_id && (
        <section className="rounded-[var(--radius-lg)] border border-dashed border-ink/15 px-6 py-8 text-center flex flex-col gap-3 items-center mt-2">
          <p className="font-serif text-2xl text-ink leading-tight">
            No plan yet.
          </p>
          <p className="text-sm text-ink-soft max-w-sm">
            Spence can sketch a few days of dinners in a couple of minutes.
            Tell it who&rsquo;s eating and what&rsquo;s on the calendar, and
            it&rsquo;ll do the rest.
          </p>
          <Link
            href="/chat"
            className="text-sm font-medium text-terracotta hover:underline underline-offset-4"
          >
            Start with Spence →
          </Link>
        </section>
      )}

      {process.env.NODE_ENV !== "production" && data.fetch_errors.length > 0 && (
        <details className="text-xs text-ink-soft border border-amber/30 rounded-md p-3 mt-4">
          <summary>fetch errors ({data.fetch_errors.length})</summary>
          <pre className="whitespace-pre-wrap mt-2">
            {data.fetch_errors.join("\n")}
          </pre>
        </details>
      )}
    </div>
  );
}
