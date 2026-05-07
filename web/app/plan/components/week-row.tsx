"use client";

import * as React from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/primitives/card";
import { Badge } from "@/components/primitives/badge";
import { dayShort, prettyDate } from "@/lib/dates";
import type { PlanMeal } from "@/lib/mcp";
import { MealOptionsSheet } from "./meal-options-sheet";

export interface WeekRowProps {
  date: string;
  meal: PlanMeal | null;
  /** Compact weather glyph, e.g. "☁". */
  weatherGlyph?: string;
  conflict?: boolean;
  /** "Tonight ▶" pill on today's row. */
  isToday?: boolean;
}

/**
 * WeekRow — one row in the /plan week view.
 *
 * Tap → /recipe/[meal_id]. Long-press (or click the kebab) → MealOptionsSheet
 * with Swap / Cancel / Move / Lock actions. Empty slots render an inline
 * "+ add dinner" affordance pointing at /chat.
 */
export function WeekRow({ date, meal, weatherGlyph, conflict, isToday }: WeekRowProps) {
  const [optionsOpen, setOptionsOpen] = React.useState(false);
  const longPressRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleTouchStart = () => {
    longPressRef.current = setTimeout(() => setOptionsOpen(true), 480);
  };
  const handleTouchEnd = () => {
    if (longPressRef.current) {
      clearTimeout(longPressRef.current);
      longPressRef.current = null;
    }
  };

  if (!meal) {
    return (
      <Card variant="muted" data-testid="week-row-empty">
        <CardContent className="flex items-center justify-between gap-3 p-4">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-sm text-ink-soft uppercase">
              {dayShort(date)}
            </span>
            {weatherGlyph && (
              <span aria-hidden className="text-base text-ink-soft">{weatherGlyph}</span>
            )}
            {isToday && <Badge tone="terracotta">Tonight ▶</Badge>}
          </div>
          <Link
            href="/chat"
            className="text-sm text-terracotta font-medium hover:underline underline-offset-4"
          >
            + add dinner
          </Link>
        </CardContent>
      </Card>
    );
  }

  const cuisine = Array.isArray(meal.cuisine) ? meal.cuisine[0] : meal.cuisine;
  const serves = meal.serves ?? meal.people;

  return (
    <>
      <Card
        className="hover:bg-white transition-colors"
        data-testid="week-row"
      >
        <CardContent
          className="flex flex-col gap-2 p-4"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
          onTouchMove={handleTouchEnd}
          onContextMenu={(e) => {
            e.preventDefault();
            setOptionsOpen(true);
          }}
        >
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-sm text-ink-soft uppercase">
              {dayShort(date)}
            </span>
            {weatherGlyph && (
              <span aria-hidden className="text-base text-ink-soft">{weatherGlyph}</span>
            )}
            {isToday && <Badge tone="terracotta">Tonight ▶</Badge>}
            {conflict && <Badge tone="amber">⚠ calendar conflict</Badge>}
            {meal.locked && <Badge tone="ink">locked</Badge>}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setOptionsOpen(true);
              }}
              className="ml-auto text-ink-soft hover:text-ink p-1 -m-1 rounded-md"
              aria-label="Meal options"
            >
              ⋯
            </button>
          </div>
          <Link
            href={meal.id ? `/recipe/${meal.id}` : "#"}
            className="flex flex-col gap-1"
          >
            <p className="font-serif text-xl leading-tight text-ink">{meal.title}</p>
            <p className="text-xs text-ink-soft uppercase tracking-wide">
              {[
                meal.format?.replace(/_/g, " "),
                cuisine,
                typeof serves === "number" ? `${serves} ppl` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </Link>
        </CardContent>
      </Card>
      <MealOptionsSheet
        open={optionsOpen}
        onClose={() => setOptionsOpen(false)}
        meal={meal}
        date={prettyDate(date)}
      />
    </>
  );
}
