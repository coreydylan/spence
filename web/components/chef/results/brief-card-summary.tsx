import Link from "next/link";
import { Card, CardContent } from "@/components/primitives/card";
import type { MorningBrief } from "@/lib/mcp";

interface Props {
  brief: MorningBrief;
}

/**
 * Inline morning-brief card for the chat surface. Same shape as the
 * full /inbox card, but a touch more compact.
 */
export function BriefCardSummary({ brief }: Props) {
  const lead = brief.suggestions[0]?.message ?? null;
  return (
    <Card>
      <CardContent className="p-4 flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <h4 className="font-serif text-lg text-ink tracking-tight">
            {humanizeDate(brief.date)} brief
          </h4>
        </div>
        {brief.weather?.pattern_summary && (
          <p className="text-sm text-ink-soft">
            {brief.weather.pattern_summary}
          </p>
        )}
        {lead && (
          <p className="text-sm text-ink leading-relaxed">{lead}</p>
        )}
        <Link
          href={`/inbox/${encodeURIComponent(brief.date)}`}
          className="text-sm text-terracotta underline underline-offset-4 mt-1"
        >
          Open brief →
        </Link>
      </CardContent>
    </Card>
  );
}

function humanizeDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
