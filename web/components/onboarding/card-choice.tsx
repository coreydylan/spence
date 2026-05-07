"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

export interface CardChoiceProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Big label, top of card. */
  label: string;
  /** Optional supporting copy. */
  hint?: string;
  /** Optional leading symbol/emoji/icon. */
  glyph?: React.ReactNode;
  selected?: boolean;
  /** Use a chunkier mobile-friendly layout (~80px tall). */
  size?: "md" | "lg";
}

/**
 * CardChoice — the canonical big-tappable answer card.
 *
 * Selected state uses a sage outline (per spec). Hover lifts subtly.
 * Default minHeight is 80px on `lg` so they're thumb-friendly on mobile.
 */
export const CardChoice = React.forwardRef<HTMLButtonElement, CardChoiceProps>(
  function CardChoice(
    { label, hint, glyph, selected, size = "lg", className, ...rest },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type="button"
        aria-pressed={selected ? true : undefined}
        className={cn(
          "group w-full text-left rounded-[var(--radius-lg)] border transition-all duration-150",
          "bg-white/70 hover:bg-white shadow-[var(--shadow-soft)] hover:-translate-y-px",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta",
          size === "lg" ? "px-5 py-5 min-h-[80px]" : "px-4 py-3",
          selected
            ? "border-sage ring-2 ring-sage/40 bg-white"
            : "border-ink/8",
          className,
        )}
        {...rest}
      >
        <div className="flex items-center gap-4">
          {glyph && (
            <span className="shrink-0 text-2xl text-terracotta" aria-hidden>
              {glyph}
            </span>
          )}
          <div className="flex-1 flex flex-col gap-0.5">
            <span className="font-serif text-xl text-ink leading-tight">
              {label}
            </span>
            {hint && (
              <span className="text-sm text-ink-soft leading-snug">{hint}</span>
            )}
          </div>
          {selected && (
            <span
              className="shrink-0 inline-flex h-6 w-6 items-center justify-center rounded-full bg-sage text-cream text-xs"
              aria-hidden
            >
              {"✓"}
            </span>
          )}
        </div>
      </button>
    );
  },
);
