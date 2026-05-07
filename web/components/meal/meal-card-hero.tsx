import * as React from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/primitives/card";
import { Badge } from "@/components/primitives/badge";
import { Button } from "@/components/primitives/button";
import { cn } from "@/lib/cn";
import { pretty12h } from "@/lib/dates";
import type { PlanMeal } from "@/lib/mcp";

interface MealCardHeroProps {
  meal: PlanMeal;
  /** "Tonight's dinner" / "Friday dinner" — overline above the title. */
  overline?: string;
  /** When true, render the calendar-conflict amber badge in the meta row. */
  conflict?: boolean;
  className?: string;
}

const FORMAT_GRADIENT: Record<string, string> = {
  donburi: "from-amber-soft to-terracotta",
  grain_bowl: "from-sage-soft to-sage",
  pasta: "from-amber to-terracotta",
  pizza: "from-terracotta to-amber",
  tacos: "from-amber to-amber-soft",
  curry: "from-amber to-sage",
  stew: "from-amber-soft to-amber",
  braise: "from-ink-soft to-ink",
  sheet_pan: "from-amber-soft to-sage-soft",
  default: "from-cream-deep to-cream",
};

/**
 * MealCardHero — the "tonight's dinner" hero card on /today.
 *
 * Differs from <MealCard variant="hero">:
 *   - Larger photo / gradient header (h-64).
 *   - Ribbon overline ("TONIGHT'S DINNER").
 *   - Always renders a serif title at 36px.
 *   - Embeds an "Open recipe" CTA button instead of relying on parent click.
 *   - Surfaces a calendar-conflict badge inline.
 */
export function MealCardHero({
  meal,
  overline,
  conflict,
  className,
}: MealCardHeroProps) {
  const cuisine = Array.isArray(meal.cuisine) ? meal.cuisine[0] : meal.cuisine;
  const serves = meal.serves ?? meal.people;
  const active = meal.active_minutes ?? meal.active_time_min ?? null;
  const gradient =
    FORMAT_GRADIENT[meal.format ?? "default"] ?? FORMAT_GRADIENT.default;
  const start = meal.suggested_start_time;

  return (
    <Card
      variant="raised"
      className={cn("overflow-hidden", className)}
      data-testid="meal-card-hero"
    >
      <div
        className={cn("w-full h-64 bg-gradient-to-br", gradient)}
        style={
          meal.photo_url
            ? {
                backgroundImage: `url("${meal.photo_url}")`,
                backgroundSize: "cover",
                backgroundPosition: "center",
              }
            : undefined
        }
      />
      <CardContent className="flex flex-col gap-4 p-6 md:p-8">
        {overline && (
          <p className="text-xs uppercase tracking-[0.18em] text-terracotta font-semibold">
            {overline}
          </p>
        )}
        <h2 className="font-serif text-3xl md:text-4xl leading-[1.05] text-ink">
          {meal.title}
        </h2>

        <div className="flex flex-wrap items-center gap-2">
          {meal.format && <Badge tone="terracotta">{meal.format.replace(/_/g, " ")}</Badge>}
          {cuisine && <Badge tone="sage">{cuisine}</Badge>}
          {typeof serves === "number" && <Badge>serves {serves}</Badge>}
          {conflict && <Badge tone="amber">calendar conflict</Badge>}
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm text-ink-soft">
          {active !== null && (
            <div className="flex flex-col">
              <dt className="text-xs uppercase tracking-wide">Active</dt>
              <dd className="font-mono text-base text-ink">{active} min</dd>
            </div>
          )}
          {start && (
            <div className="flex flex-col">
              <dt className="text-xs uppercase tracking-wide">Start cooking</dt>
              <dd className="font-mono text-base text-ink">{pretty12h(start)}</dd>
            </div>
          )}
        </dl>

        {meal.id && (
          <div className="pt-2">
            <Link href={`/recipe/${meal.id}`} className="inline-block">
              <Button variant="primary" size="lg" className="w-full md:w-auto">
                Open recipe
              </Button>
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
