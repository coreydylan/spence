import * as React from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/primitives/card";
import { Badge } from "@/components/primitives/badge";
import { dayShort, pretty12h } from "@/lib/dates";
import type { UpcomingMeal } from "@/lib/today-data";

interface ComingUpProps {
  upcoming: UpcomingMeal[];
}

/**
 * ComingUp — the "coming up" mini-list under tonight's dinner on /today.
 *
 * Each row is a tappable card linking to /recipe/[meal_id]. Skips days
 * where no dinner slot is filled. Renders a calendar-conflict amber chip
 * inline.
 */
export function ComingUp({ upcoming }: ComingUpProps) {
  const filled = upcoming.filter((u) => u.meal !== null);
  if (filled.length === 0) return null;

  return (
    <section className="flex flex-col gap-3" aria-label="Coming up">
      <h3 className="text-xs uppercase tracking-[0.18em] text-ink-soft font-semibold">
        Coming up
      </h3>
      <ul className="flex flex-col gap-3">
        {filled.map((u) => (
          <ComingUpRow key={u.date} entry={u} />
        ))}
      </ul>
    </section>
  );
}

function ComingUpRow({ entry }: { entry: UpcomingMeal }) {
  const meal = entry.meal!;
  const cuisine = Array.isArray(meal.cuisine) ? meal.cuisine[0] : meal.cuisine;
  const start = meal.suggested_start_time;

  const inner = (
    <Card
      className="hover:bg-white transition-colors"
      data-testid="coming-up-row"
    >
      <CardContent className="flex flex-col gap-1.5 p-4">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-sm text-ink-soft uppercase">
            {dayShort(entry.date)}
          </span>
          {entry.conflict && <Badge tone="amber">calendar conflict</Badge>}
          {start && (
            <span className="ml-auto font-mono text-sm text-ink-soft">
              {pretty12h(start)}
            </span>
          )}
        </div>
        <p className="font-serif text-lg leading-tight text-ink">{meal.title}</p>
        {(meal.format || cuisine) && (
          <p className="text-xs text-ink-soft">
            {[meal.format?.replace(/_/g, " "), cuisine].filter(Boolean).join(" · ")}
          </p>
        )}
      </CardContent>
    </Card>
  );

  return (
    <li>
      {meal.id ? (
        <Link href={`/recipe/${meal.id}`} className="block">
          {inner}
        </Link>
      ) : (
        inner
      )}
    </li>
  );
}
