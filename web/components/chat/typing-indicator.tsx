import * as React from "react";
import { cn } from "@/lib/cn";

interface TypingIndicatorProps {
  className?: string;
  /** Shrink to inline size (used inside an existing bubble). */
  inline?: boolean;
  label?: string;
}

/**
 * TypingIndicator — three-dot pulse displayed before Spence's first text
 * token streams in. Used in both standalone (no bubble) and inline (inside
 * a bubble next to tool-call chips) modes.
 *
 * Honors `prefers-reduced-motion` via the `animate-pulse-dot` keyframes,
 * which already disables under reduced motion globally.
 */
export function TypingIndicator({
  className,
  inline,
  label = "Spence is thinking",
}: TypingIndicatorProps) {
  return (
    <div
      role="status"
      aria-label={label}
      className={cn(
        "flex items-center gap-1",
        inline ? "py-0" : "py-1.5",
        className,
      )}
    >
      <span
        className={cn(
          "rounded-full bg-terracotta animate-pulse-dot",
          inline ? "h-1.5 w-1.5" : "h-2 w-2",
        )}
        style={{ animationDelay: "0ms" }}
      />
      <span
        className={cn(
          "rounded-full bg-terracotta animate-pulse-dot",
          inline ? "h-1.5 w-1.5" : "h-2 w-2",
        )}
        style={{ animationDelay: "200ms" }}
      />
      <span
        className={cn(
          "rounded-full bg-terracotta animate-pulse-dot",
          inline ? "h-1.5 w-1.5" : "h-2 w-2",
        )}
        style={{ animationDelay: "400ms" }}
      />
      <span className="sr-only">{label}</span>
    </div>
  );
}
