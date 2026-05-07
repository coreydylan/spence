import * as React from "react";
import { pretty12h } from "@/lib/dates";
import type { CookTimelineStep } from "@/lib/recipe-data";

interface Props {
  steps: CookTimelineStep[];
}

/**
 * CookTimeline — vertical timeline of "HH:MM  do this" rows.
 *
 * Render path:
 *   - When `inspire_read_recipe_steps` returns real data, those steps map
 *     directly to rows here (source: "recipe_steps").
 *   - Otherwise the heuristic timeline derived from the meal's format
 *     fills in (source: "heuristic"); we render a tiny "estimate" tag.
 */
export function CookTimeline({ steps }: Props) {
  if (!steps || steps.length === 0) {
    return (
      <p className="text-sm text-ink-soft italic">
        No timeline yet — start cooking and Spence will walk you through it.
      </p>
    );
  }

  const isHeuristic = steps[0]?.source === "heuristic";

  return (
    <div className="flex flex-col gap-1">
      {isHeuristic && (
        <p className="text-xs text-ink-soft italic mb-2">
          Estimate based on format. Real recipe steps render here once selected.
        </p>
      )}
      <ol className="flex flex-col">
        {steps.map((step, i) => (
          <li
            key={`${step.time}-${i}`}
            className="grid grid-cols-[80px_1fr] gap-4 py-3 border-b border-ink/5 last:border-0"
          >
            <span className="font-mono text-sm text-ink-soft tabular-nums">
              {pretty12h(step.time)}
            </span>
            <span className="text-base text-ink leading-snug">{step.prose}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
