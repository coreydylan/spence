import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/primitives/button";
import { Card, CardContent } from "@/components/primitives/card";
import { MealCardHero } from "@/components/meal/meal-card-hero";
import type { PlanMeal } from "@/lib/mcp";

interface TodayHeroProps {
  tonight: PlanMeal | null;
  conflict: boolean;
  has_plan: boolean;
}

/**
 * TodayHero — the "TONIGHT'S DINNER" section.
 *
 * - When a meal exists: render <MealCardHero>.
 * - When the household has a plan but tonight's dinner slot is empty: a
 *   "compose dinner" CTA pointing at /chat.
 * - When no plan exists: a softer "no plan yet" card with the same CTA.
 */
export function TodayHero({ tonight, conflict, has_plan }: TodayHeroProps) {
  if (tonight) {
    return (
      <MealCardHero
        meal={tonight}
        overline="Tonight's dinner"
        conflict={conflict}
      />
    );
  }

  return (
    <Card variant="muted" className="text-center">
      <CardContent className="flex flex-col items-center gap-3 p-8">
        <p className="text-xs uppercase tracking-[0.18em] text-terracotta font-semibold">
          Tonight&rsquo;s dinner
        </p>
        <h2 className="font-serif text-2xl md:text-3xl leading-tight text-ink">
          {has_plan
            ? "No dinner on tonight."
            : "No plan yet — let&rsquo;s draft one."}
        </h2>
        <p className="text-sm text-ink-soft max-w-sm">
          {has_plan
            ? "Tap below to compose tonight&rsquo;s dinner with Spence."
            : "Spence can sketch the next few days in a couple of minutes."}
        </p>
        <Link href="/chat" className="mt-2">
          <Button variant="primary" size="lg">
            {has_plan ? "Compose dinner" : "Plan with Spence"}
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}
