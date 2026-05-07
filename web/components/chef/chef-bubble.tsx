import * as React from "react";
import { cn } from "@/lib/cn";

interface ChefBubbleProps {
  children?: React.ReactNode;
  /** Renders a typing indicator instead of children. */
  typing?: boolean;
  className?: string;
}

/**
 * ChefBubble — Spence's chat bubble. Always left-aligned, with a small
 * terracotta dot avatar to the left.
 *
 * - text and any inline UI components render inside the bubble
 * - if `typing` is true, shows a 3-dot pulse instead of children
 *
 * Composition: pass plain text, JSX, or full components (MealCard, etc.) as
 * children. The bubble adapts width to its content.
 */
export function ChefBubble({ children, typing, className }: ChefBubbleProps) {
  return (
    <div className={cn("flex items-start gap-3 max-w-[42rem] animate-fade-up", className)}>
      <SpenceAvatar />
      <div
        className={cn(
          "rounded-[var(--radius-lg)] rounded-tl-md bg-white/70 px-4 py-3 shadow-[var(--shadow-soft)] text-ink",
          "min-h-[2.5rem] flex flex-col gap-2",
        )}
      >
        {typing ? <TypingDots /> : children}
      </div>
    </div>
  );
}

function SpenceAvatar() {
  return (
    <div
      aria-label="Spence"
      className="mt-1 h-7 w-7 shrink-0 rounded-full bg-terracotta flex items-center justify-center text-cream font-serif text-sm shadow-[var(--shadow-soft)]"
    >
      S
    </div>
  );
}

function TypingDots() {
  return (
    <div className="flex items-center gap-1 py-1" aria-label="Spence is typing">
      <span className="h-2 w-2 rounded-full bg-terracotta animate-pulse-dot" style={{ animationDelay: "0ms" }} />
      <span className="h-2 w-2 rounded-full bg-terracotta animate-pulse-dot" style={{ animationDelay: "200ms" }} />
      <span className="h-2 w-2 rounded-full bg-terracotta animate-pulse-dot" style={{ animationDelay: "400ms" }} />
    </div>
  );
}
