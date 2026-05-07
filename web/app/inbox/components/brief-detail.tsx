import { Card, CardContent } from "@/components/primitives/card";
import { Badge } from "@/components/primitives/badge";
import type { MorningBrief } from "@/lib/mcp";

interface Props {
  brief: MorningBrief;
}

/**
 * Full brief view — every section the worker stamped: weather, calendar
 * windows, plan-health snapshots, suggestions, and the onboarding question
 * of the day if one was surfaced. Each section is a small card so the page
 * stays scannable on mobile.
 */
export function BriefDetail({ brief }: Props) {
  return (
    <div className="flex flex-col gap-4">
      {brief.weather && (
        <Card>
          <CardContent className="p-5">
            <h3 className="font-serif text-xl text-ink tracking-tight">
              Weather
            </h3>
            <p className="text-sm text-ink-soft mt-1.5 leading-relaxed">
              {brief.weather.pattern_summary}
            </p>
            {brief.weather.forecast && brief.weather.forecast.length > 0 && (
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {brief.weather.forecast.slice(0, 4).map((f) => (
                  <div
                    key={f.date}
                    className="rounded-[var(--radius-sm)] bg-cream-deep px-3 py-2"
                  >
                    <div className="text-xs text-ink-soft uppercase">
                      {humanizeShort(f.date)}
                    </div>
                    <div className="font-mono text-sm tabular-nums text-ink mt-0.5">
                      {Math.round(f.high_f)}° / {Math.round(f.low_f)}°
                    </div>
                    <div className="text-xs text-ink-soft mt-0.5 truncate">
                      {f.conditions}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {brief.weather.cooking_hints &&
              brief.weather.cooking_hints.length > 0 && (
                <ul className="mt-3 text-sm text-ink-soft space-y-1">
                  {brief.weather.cooking_hints.map((h, i) => (
                    <li key={i}>· {h}</li>
                  ))}
                </ul>
              )}
          </CardContent>
        </Card>
      )}

      {brief.calendar && brief.calendar.length > 0 && (
        <Card>
          <CardContent className="p-5">
            <h3 className="font-serif text-xl text-ink tracking-tight">
              Calendar
            </h3>
            <div className="mt-3 space-y-3">
              {brief.calendar.map((c) => (
                <div key={c.date} className="flex flex-col gap-1.5">
                  <div className="text-sm text-ink-soft">
                    {humanizeDate(c.date)}
                  </div>
                  {c.busy_blocks.length > 0 ? (
                    <ul className="text-sm space-y-1">
                      {c.busy_blocks.map((b, i) => (
                        <li key={i} className="flex items-center gap-2">
                          <span className="font-mono text-xs text-amber tabular-nums">
                            {shortTime(b.start)}
                          </span>
                          <span>{b.title}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-ink-soft/70">No conflicts.</p>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {brief.suggestions && brief.suggestions.length > 0 && (
        <Card>
          <CardContent className="p-5">
            <h3 className="font-serif text-xl text-ink tracking-tight">
              Suggestions
            </h3>
            <ul className="mt-3 space-y-2.5 text-sm">
              {brief.suggestions.map((s, i) => (
                <li key={i} className="flex items-start gap-2">
                  <Badge tone={toneForSuggestion(s.kind)}>
                    {s.kind.replace(/_/g, " ")}
                  </Badge>
                  <span className="flex-1 text-ink leading-relaxed">
                    {s.message}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {brief.plan_health && brief.plan_health.length > 0 && (
        <Card>
          <CardContent className="p-5">
            <h3 className="font-serif text-xl text-ink tracking-tight">
              Plan health
            </h3>
            <ul className="mt-3 space-y-2 text-sm">
              {brief.plan_health.map((h, i) => (
                <li key={i} className="text-ink">
                  {"plan_id" in h && (
                    <span className="font-mono text-xs text-ink-soft">
                      {String(h.plan_id).slice(0, 8)}…
                    </span>
                  )}
                  {"headline_issue" in h && h.headline_issue && (
                    <span className="ml-2 text-amber">{String(h.headline_issue)}</span>
                  )}
                  {"hard_grievance_count" in h && (
                    <span className="ml-2 text-ink-soft text-xs">
                      {Number(h.hard_grievance_count) || 0} hard ·{" "}
                      {Number(h.warning_grievance_count) || 0} warning
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {brief.onboarding_question && (
        <Card variant="muted">
          <CardContent className="p-5">
            <h3 className="font-serif text-xl text-ink tracking-tight">
              Today&apos;s question
            </h3>
            <p className="text-base text-ink mt-2 leading-relaxed">
              {(brief.onboarding_question as { text?: string; prompt?: string }).text ??
                (brief.onboarding_question as { prompt?: string }).prompt ??
                "(no text)"}
            </p>
          </CardContent>
        </Card>
      )}

      {brief.notifications_summary?.count_by_kind &&
        Object.keys(brief.notifications_summary.count_by_kind).length > 0 && (
          <Card>
            <CardContent className="p-5">
              <h3 className="font-serif text-xl text-ink tracking-tight">
                Notifications fired
              </h3>
              <ul className="mt-3 flex flex-wrap gap-2 text-sm">
                {Object.entries(
                  brief.notifications_summary.count_by_kind,
                ).map(([k, v]) => (
                  <li key={k}>
                    <Badge tone="neutral">
                      {k.replace(/_/g, " ")} · {v}
                    </Badge>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
    </div>
  );
}

function toneForSuggestion(
  kind: string,
): "amber" | "sage" | "terracotta" | "neutral" {
  if (kind === "tight_window" || kind === "missed_prep") return "amber";
  if (kind === "expiring_soon") return "amber";
  if (kind === "shop_today") return "terracotta";
  if (kind === "prep_today") return "sage";
  return "neutral";
}

function humanizeDate(iso?: string): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso ?? "";
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function humanizeShort(iso?: string): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso ?? "";
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    timeZone: "UTC",
  });
}

function shortTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}
