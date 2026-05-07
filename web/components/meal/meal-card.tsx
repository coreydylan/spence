"use client";

import * as React from "react";
import { Card, CardContent } from "@/components/primitives/card";
import { Badge } from "@/components/primitives/badge";
import { cn } from "@/lib/cn";

interface Meal {
  id?: string;
  title: string;
  format?: string;
  cuisine?: string;
  serves?: number;
  active_minutes?: number;
  total_minutes?: number;
  suggested_start_time?: string;
  notes?: string[];
  photo_url?: string;
  components?: Array<{ role?: string; title?: string }>;
}

interface MealCardProps {
  meal: Meal;
  /** Show as compact (chat) or full (recipe page header). */
  variant?: "compact" | "hero";
  onOpen?: (mealId: string) => void;
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
  default: "from-cream-deep to-cream",
};

/**
 * MealCard — the canonical "this is a meal" surface.
 *
 * - compact: 1-line meta + title, used inline in chat replies and on /plan
 * - hero:    big photo/gradient header, used on the recipe detail page
 *
 * If `meal.photo_url` is present, it renders the corpus photo. Otherwise we
 * derive a gradient from the meal.format.
 */
export function MealCard({
  meal,
  variant = "compact",
  onOpen,
  className,
}: MealCardProps) {
  const isHero = variant === "hero";
  const gradient = FORMAT_GRADIENT[meal.format ?? "default"] ?? FORMAT_GRADIENT.default;

  return (
    <Card
      variant="raised"
      className={cn(
        "overflow-hidden cursor-pointer transition-transform hover:-translate-y-0.5",
        isHero ? "max-w-2xl" : "max-w-md",
        className,
      )}
      role={onOpen ? "button" : undefined}
      onClick={() => meal.id && onOpen?.(meal.id)}
    >
      <div
        className={cn(
          "w-full bg-gradient-to-br",
          gradient,
          isHero ? "h-56" : "h-24",
        )}
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
      <CardContent className="flex flex-col gap-2 p-5">
        <h3 className={cn("font-serif text-ink leading-tight", isHero ? "text-3xl" : "text-xl")}>
          {meal.title}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          {meal.format && <Badge tone="terracotta">{meal.format.replace(/_/g, " ")}</Badge>}
          {meal.cuisine && <Badge tone="sage">{meal.cuisine}</Badge>}
          {typeof meal.serves === "number" && <Badge>serves {meal.serves}</Badge>}
        </div>
        {(meal.active_minutes || meal.total_minutes || meal.suggested_start_time) && (
          <div className="text-sm text-ink-soft flex flex-wrap gap-x-4 gap-y-0.5">
            {meal.active_minutes && <span>{meal.active_minutes} min active</span>}
            {meal.total_minutes && meal.total_minutes !== meal.active_minutes && (
              <span>{meal.total_minutes} min total</span>
            )}
            {meal.suggested_start_time && (
              <span>start at {meal.suggested_start_time}</span>
            )}
          </div>
        )}
        {meal.notes && meal.notes.length > 0 && (
          <ul className="text-sm text-amber border-l-2 border-amber/50 pl-3 mt-1 flex flex-col gap-0.5">
            {meal.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
