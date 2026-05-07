"use client";

import * as React from "react";
import Link from "next/link";
import { Sheet } from "@/components/primitives/sheet";
import { Button } from "@/components/primitives/button";
import type { PlanMeal } from "@/lib/mcp";

interface Props {
  open: boolean;
  onClose: () => void;
  meal: PlanMeal;
  date: string;
}

/**
 * MealOptionsSheet — bottom sheet of long-press actions on a /plan row.
 *
 * Phase 3 ships the navigation-only branches: opening the recipe and a
 * deep-link to the chat for swap/cancel/move/lock. The actual MCP
 * mutations (plan_swap_ingredient, plan_cancel_meal, plan_move_meal,
 * plan_lock_meal) are wired through the conversational flow rather than
 * one-tap mutators in this iteration.
 */
export function MealOptionsSheet({ open, onClose, meal, date }: Props) {
  return (
    <Sheet open={open} onClose={onClose}>
      <div className="px-6 pt-6 pb-8 flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <p className="text-xs uppercase tracking-[0.18em] text-ink-soft font-semibold">
            {date}
          </p>
          <h3 className="font-serif text-2xl text-ink">{meal.title}</h3>
        </div>
        <ul className="flex flex-col gap-2">
          <SheetAction
            label="Open recipe"
            href={meal.id ? `/recipe/${meal.id}` : "#"}
            primary
          />
          <SheetAction
            label="Swap this meal"
            href={`/chat?prompt=${encodeURIComponent(`Swap ${meal.title} for something else`)}`}
          />
          <SheetAction
            label="Cancel this meal"
            href={`/chat?prompt=${encodeURIComponent(`Cancel ${meal.title}`)}`}
          />
          <SheetAction
            label="Move to another slot"
            href={`/chat?prompt=${encodeURIComponent(`Move ${meal.title} to a different night`)}`}
          />
          <SheetAction
            label={meal.locked ? "Unlock" : "Lock this meal"}
            href={`/chat?prompt=${encodeURIComponent(
              meal.locked ? `Unlock ${meal.title}` : `Lock ${meal.title} so it stays put`,
            )}`}
          />
        </ul>
        <Button variant="ghost" onClick={onClose} className="self-stretch">
          Close
        </Button>
      </div>
    </Sheet>
  );
}

function SheetAction({
  label,
  href,
  primary,
}: {
  label: string;
  href: string;
  primary?: boolean;
}) {
  return (
    <li>
      <Link href={href} className="block">
        <Button
          variant={primary ? "primary" : "outline"}
          size="lg"
          className="w-full justify-start"
        >
          {label}
        </Button>
      </Link>
    </li>
  );
}
