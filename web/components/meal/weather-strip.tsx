import * as React from "react";
import { cn } from "@/lib/cn";

interface WeatherStripProps {
  conditions: string | null;
  high_f: number | null;
  low_f: number | null;
  pattern_summary: string | null;
  className?: string;
}

/**
 * WeatherStrip — compact 1-line weather summary used at the top of /today.
 *
 * Renders:    ☁  74° / 55°    Mild and dry. Good day for the grill.
 *
 * Designed to sit between the date headline and the dinner card with very
 * little visual weight — typography only, no card surface.
 */
export function WeatherStrip({
  conditions,
  high_f,
  low_f,
  pattern_summary,
  className,
}: WeatherStripProps) {
  if (!conditions && high_f === null && !pattern_summary) return null;

  return (
    <div
      className={cn(
        "flex flex-wrap items-baseline gap-x-3 gap-y-1 text-ink-soft",
        className,
      )}
      data-testid="weather-strip"
    >
      <span className="text-base">{conditionGlyph(conditions)}</span>
      {(high_f !== null || low_f !== null) && (
        <span className="font-mono text-sm tracking-wide text-ink">
          {high_f !== null ? `${Math.round(high_f)}°` : "—"}
          <span className="mx-1 text-ink-soft">/</span>
          {low_f !== null ? `${Math.round(low_f)}°` : "—"}
        </span>
      )}
      {pattern_summary && (
        <span className="text-sm leading-snug text-ink-soft">{pattern_summary}</span>
      )}
    </div>
  );
}

function conditionGlyph(c: string | null | undefined): string {
  if (!c) return "·";
  const k = c.toLowerCase();
  if (k.includes("storm")) return "⛈";
  if (k.includes("rain") || k.includes("drizzle")) return "🌧";
  if (k.includes("snow")) return "❄";
  if (k.includes("fog")) return "🌫";
  if (k.includes("sun") || k.includes("clear")) return "☀";
  if (k.includes("cloud") || k.includes("overcast") || k.includes("partly")) return "☁";
  return "·";
}
