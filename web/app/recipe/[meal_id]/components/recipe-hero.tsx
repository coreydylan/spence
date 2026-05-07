import * as React from "react";
import { Card, CardContent } from "@/components/primitives/card";
import { Badge } from "@/components/primitives/badge";
import { pretty12h } from "@/lib/dates";
import type { PlanMeal } from "@/lib/mcp";

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

interface RecipeHeroProps {
  meal: PlanMeal;
  active_minutes: number;
  start_cooking_time: string;
  eat_time: string;
  /** Slot in CardContent — typically the StartCookingButton client island. */
  cta?: React.ReactNode;
}

/**
 * RecipeHero — top of the /recipe/[meal_id] page.
 *
 * A larger version of MealCardHero with a method-summary underneath the
 * title, a "Start cooking at HH:MM to eat at HH:MM" line, and a slot for
 * the (client-side) Start cooking button.
 */
export function RecipeHero({
  meal,
  active_minutes,
  start_cooking_time,
  eat_time,
  cta,
}: RecipeHeroProps) {
  const cuisine = Array.isArray(meal.cuisine) ? meal.cuisine[0] : meal.cuisine;
  const serves = meal.serves ?? meal.people;
  const gradient =
    FORMAT_GRADIENT[meal.format ?? "default"] ?? FORMAT_GRADIENT.default;

  return (
    <Card variant="raised" className="overflow-hidden">
      <div
        className={`w-full h-56 md:h-72 bg-gradient-to-br ${gradient}`}
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
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-3xl md:text-4xl leading-[1.05] text-ink">
            {meal.title}
          </h1>
          {meal.method_summary && (
            <p className="font-serif text-lg text-ink-soft italic leading-snug">
              {meal.method_summary}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {meal.format && <Badge tone="terracotta">{meal.format.replace(/_/g, " ")}</Badge>}
          {cuisine && <Badge tone="sage">{cuisine}</Badge>}
          {typeof serves === "number" && <Badge>serves {serves}</Badge>}
        </div>

        <div className="flex flex-col gap-1 text-sm">
          <p className="flex items-center gap-2">
            <span aria-hidden>🔥</span>
            <span className="font-mono text-ink">{active_minutes} min active</span>
          </p>
          <p className="text-ink-soft">
            Start cooking at{" "}
            <span className="font-mono text-ink">{pretty12h(start_cooking_time)}</span>{" "}
            to eat at <span className="font-mono text-ink">{pretty12h(eat_time)}</span>
          </p>
        </div>

        {cta && <div className="pt-2">{cta}</div>}
      </CardContent>
    </Card>
  );
}
