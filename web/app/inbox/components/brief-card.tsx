import Link from "next/link";
import { Card, CardContent } from "@/components/primitives/card";
import { Badge } from "@/components/primitives/badge";
import type { MorningBrief } from "@/lib/mcp";

interface Props {
  brief: MorningBrief;
}

/**
 * One brief, condensed. Shows date, weather one-liner, the headline
 * suggestion (first one), and a chevron if there's more in the detail.
 *
 * Tap → /inbox/[brief_id] which uses the date as the id (briefs are
 * one-per-household per day).
 */
export function BriefCard({ brief }: Props) {
  const headline = brief.suggestions[0]?.message ?? null;
  const conflicts = (brief.calendar ?? []).flatMap((c) =>
    (c.busy_blocks ?? []).map((b) => `${b.title} ${shortTime(b.start)}`),
  );

  return (
    <Link
      href={`/inbox/${encodeURIComponent(brief.date)}`}
      className="block hover:opacity-95 transition-opacity"
    >
      <Card>
        <CardContent className="p-5 flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <h3 className="font-serif text-xl text-ink tracking-tight">
              {humanizeDate(brief.date)} — brief
            </h3>
            <Badge tone="terracotta">brief</Badge>
          </div>

          {brief.weather?.pattern_summary && (
            <p className="text-sm text-ink-soft">
              {brief.weather.pattern_summary}
            </p>
          )}

          {headline && (
            <p className="text-sm text-ink leading-relaxed">{headline}</p>
          )}

          {conflicts.length > 0 && (
            <p className="text-xs text-amber leading-relaxed">
              ⚠ {conflicts.length}{" "}
              {conflicts.length === 1 ? "calendar conflict" : "calendar conflicts"}
            </p>
          )}

          <div className="flex items-center gap-2 text-xs text-ink-soft mt-1">
            {brief.suggestions.length > 0 && (
              <span>
                {brief.suggestions.length}{" "}
                {brief.suggestions.length === 1
                  ? "suggestion"
                  : "suggestions"}
              </span>
            )}
            {brief.onboarding_question && (
              <span className="text-terracotta">+ daily question</span>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function humanizeDate(iso: string): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
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
