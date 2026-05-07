import * as React from "react";
import type { PlanMeal } from "@/lib/mcp";

interface Props {
  meal: PlanMeal;
}

/**
 * NotesSection — agent / past-cook notes for the recipe page.
 *
 * Phase 3 just renders any `meal.notes[]` from the composer. The richer
 * "last cooked X weeks ago — Corey rated 4/5" comes from a future
 * `inspire_read_taste_feedback`-style tool the meal-agent already
 * accumulates; we'll wire that in Phase 5.
 */
export function NotesSection({ meal }: Props) {
  const notes = meal.notes ?? [];
  if (notes.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {notes.map((n, i) => (
        <p
          key={i}
          className="text-sm text-ink-soft border-l-2 border-amber/40 pl-3 py-1 italic leading-snug"
        >
          {n}
        </p>
      ))}
    </div>
  );
}
