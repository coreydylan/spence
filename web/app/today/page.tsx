import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getSessionFromHeaders } from "@/lib/auth";
import { loadTodayData, weatherStripFields } from "@/lib/today-data";
import { dayName, prettyDate, todayIso } from "@/lib/dates";
import { WeatherStrip } from "@/components/meal/weather-strip";
import { PreferenceWarning } from "@/components/meal/preference-warning";
import { TodayHero } from "./components/today-hero";
import { ComingUp } from "./components/coming-up";
import { QuestionCallout } from "./components/question-callout";

export const dynamic = "force-dynamic";

/**
 * /today — the morning brief, made beautiful.
 *
 * Server Component. Fetches in parallel:
 *   - household_read_brief
 *   - plan_list (find active plan)
 *   - chef_status_check (for the day's question)
 * Then sequentially: plan_read_meal × N (tonight + upcoming) and
 * plan_read_grievances (preference warnings).
 *
 * Tier-0-incomplete households are redirected to /onboarding (Phase 2).
 */
export default async function TodayPage() {
  const h = await headers();
  const session = await getSessionFromHeaders(h);

  const today = todayIso();
  const data = await loadTodayData(
    {
      household_id: session.household_id,
      caller_kind: "human",
      caller_id: "spence-web-today",
    },
    { today },
  );

  // Tier-0 not done → bounce to onboarding.
  if (data.needs_onboarding) {
    redirect("/onboarding");
  }

  const weather = data.brief
    ? weatherStripFields(data.brief.weather, today)
    : null;

  // Prefer the brief's onboarding question, fall back to chef_status_check.
  const question =
    data.brief?.onboarding_question ??
    data.chef_status?.recommendation.next_question ??
    null;

  return (
    <div className="flex flex-col gap-10 animate-fade-up">
      {/* ── Headline ─────────────────────────────────────────────────── */}
      <header className="flex flex-col gap-2">
        <h1 className="font-serif text-5xl md:text-6xl leading-[0.95] text-ink">
          {dayName(today)}
        </h1>
        <p className="text-base text-sage font-medium">{prettyDate(today)}</p>
        {weather && (
          <WeatherStrip
            conditions={weather.conditions}
            high_f={weather.high}
            low_f={weather.low}
            pattern_summary={weather.pattern}
            className="mt-2"
          />
        )}
      </header>

      {/* ── Tonight's dinner ─────────────────────────────────────────── */}
      <section aria-label="Tonight's dinner">
        <TodayHero
          tonight={data.tonight}
          conflict={data.tonight_calendar_conflict}
          has_plan={!!data.plan_id}
        />
      </section>

      {/* ── Coming up ────────────────────────────────────────────────── */}
      {data.upcoming.length > 0 && (
        <ComingUp upcoming={data.upcoming} />
      )}

      {/* ── Preference warnings ─────────────────────────────────────── */}
      {data.preference_warnings.length > 0 && (
        <section className="flex flex-col gap-3" aria-label="Heads up">
          {data.preference_warnings.map((g, i) => (
            <PreferenceWarning key={`${g.code}-${i}`} message={g.message} />
          ))}
        </section>
      )}

      {/* ── Onboarding question ─────────────────────────────────────── */}
      {question && <QuestionCallout question={question} />}

      {/* ── Soft footer when nothing else is here ───────────────────── */}
      {!data.tonight && !data.upcoming.length && !question && (
        <p className="text-sm text-ink-soft text-center pt-6">
          Nothing else for you today. Tap Chat to ask Spence anything.
        </p>
      )}

      {/* Dev affordance — only show when fetch errors accumulated. */}
      {process.env.NODE_ENV !== "production" && data.fetch_errors.length > 0 && (
        <details className="text-xs text-ink-soft border border-amber/30 rounded-md p-3">
          <summary>fetch errors ({data.fetch_errors.length})</summary>
          <pre className="whitespace-pre-wrap mt-2">
            {data.fetch_errors.join("\n")}
          </pre>
        </details>
      )}
    </div>
  );
}
