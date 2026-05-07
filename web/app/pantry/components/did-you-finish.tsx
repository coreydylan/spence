"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

interface Props {
  itemName: string;
  /** Called with `true` if user confirmed they finished it, `false` if "still have some". */
  onAnswer?: (finished: boolean) => void | Promise<void>;
}

/**
 * Inline two-button "Did you finish X?" prompt for items expiring soon.
 * Calls back to the parent so the parent can fire the appropriate MCP tool
 * (mark consumed, extend expires_at, etc.). MVP just hides itself after answer.
 */
export function DidYouFinish({ itemName, onAnswer }: Props) {
  const [state, setState] = React.useState<"asking" | "answered">("asking");

  if (state === "answered") return null;

  const choose = async (finished: boolean) => {
    setState("answered");
    if (onAnswer) {
      try {
        await onAnswer(finished);
      } catch {
        // Parent handles errors; we just collapse.
      }
    }
  };

  return (
    <div className="flex items-center gap-2 mt-1.5 text-sm">
      <span className="text-amber font-medium">Did you finish?</span>
      <button
        type="button"
        onClick={() => choose(true)}
        className={pillClass}
        aria-label={`Yes, finished the ${itemName}`}
      >
        Yes
      </button>
      <button
        type="button"
        onClick={() => choose(false)}
        className={cn(pillClass, "bg-cream-deep text-ink-soft")}
        aria-label={`No, still have ${itemName}`}
      >
        Still have some
      </button>
    </div>
  );
}

const pillClass =
  "px-2.5 py-0.5 rounded-[var(--radius-full)] text-xs font-medium bg-sage text-cream hover:bg-sage/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage";
