"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

export type IterationAction =
  | "wait"
  | "redo"
  | "add_ingredient"
  | "adjust_temp"
  | "extend_time"
  | "ok";

export interface IterationSuggestionData {
  task_id: string | null;
  action: IterationAction;
  detail: string;
  ingredient_to_add?: string | null;
  temp_delta_pct?: number | null;
  extra_min?: number | null;
}

export interface IterationSuggestionProps {
  suggestion: IterationSuggestionData;
  onAccept: () => void;
  onDismiss: () => void;
  className?: string;
}

/**
 * IterationSuggestion — actionable card shown when the vision flow returns a
 * `recipe_iteration_suggested` envelope.
 *
 * Renders the action verb large, the detail in body text, and two thumb-sized
 * buttons. Accept fires `iteration_response{accepted:true}`; Dismiss fires
 * `iteration_response{accepted:false}`. The DO records both for the post-mortem.
 */
export function IterationSuggestion({
  suggestion,
  onAccept,
  onDismiss,
  className,
}: IterationSuggestionProps) {
  return (
    <div
      role="alertdialog"
      aria-label="Recipe iteration suggestion"
      className={cn(
        "rounded-[var(--radius-lg)] bg-amber/10 border border-amber/40 px-5 py-5 animate-slide-up",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <SuggestionIcon action={suggestion.action} />
        <div className="flex-1 min-w-0">
          <p className="text-[11px] uppercase tracking-[0.18em] text-amber-soft mb-1 font-medium">
            Spence sees…
          </p>
          <p className="font-serif text-xl text-cream-dim leading-snug">
            {actionVerb(suggestion.action)}
          </p>
          <p className="text-base text-cream-dim/85 mt-2">{suggestion.detail}</p>
          {suggestion.ingredient_to_add && (
            <p className="text-sm text-cream-faint mt-1">
              add: <span className="text-cream-dim">{suggestion.ingredient_to_add}</span>
            </p>
          )}
          {suggestion.temp_delta_pct != null && (
            <p className="text-sm text-cream-faint mt-1">
              temp: <span className="text-cream-dim">
                {suggestion.temp_delta_pct > 0 ? "+" : ""}
                {suggestion.temp_delta_pct}%
              </span>
            </p>
          )}
          {suggestion.extra_min != null && (
            <p className="text-sm text-cream-faint mt-1">
              wait: <span className="text-cream-dim">+{suggestion.extra_min} min</span>
            </p>
          )}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={onAccept}
          className="h-12 rounded-[var(--radius-md)] bg-amber text-ink-deep text-base font-medium hover:bg-amber/90 active:bg-amber/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-soft"
        >
          Accept
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="h-12 rounded-[var(--radius-md)] border border-cream-faint/25 text-cream-dim text-base hover:bg-ink-surface-2"
        >
          Ignore
        </button>
      </div>
    </div>
  );
}

function actionVerb(a: IterationAction): string {
  switch (a) {
    case "wait":
      return "Hold off a moment";
    case "redo":
      return "Try this step again";
    case "add_ingredient":
      return "Add an ingredient";
    case "adjust_temp":
      return "Adjust the heat";
    case "extend_time":
      return "Give it more time";
    case "ok":
      return "Looking good";
  }
}

function SuggestionIcon({ action }: { action: IterationAction }) {
  // Simple varied glyphs so the action register is glanceable.
  const path =
    action === "wait" || action === "extend_time"
      ? "M12 6v6l4 2"
      : action === "redo"
      ? "M3 12a9 9 0 1 1 3 6.7L3 16"
      : action === "add_ingredient"
      ? "M12 5v14M5 12h14"
      : action === "adjust_temp"
      ? "M14 4v10.5a3.5 3.5 0 1 1-4 0V4a2 2 0 0 1 4 0z"
      : "M5 13l4 4L19 7";
  return (
    <span
      aria-hidden
      className="h-10 w-10 rounded-full bg-amber/20 flex items-center justify-center shrink-0"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="h-5 w-5 text-amber-soft"
      >
        <path d={path} />
      </svg>
    </span>
  );
}
