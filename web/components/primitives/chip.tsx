import * as React from "react";
import { cn } from "@/lib/cn";

export type ChipVariant = "default" | "selected" | "muted" | "warning" | "active";

export interface ChipProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ChipVariant;
  asChild?: boolean;
}

const variants: Record<ChipVariant, string> = {
  default:
    "bg-white/70 border border-ink/10 text-ink hover:bg-white",
  selected:
    "bg-terracotta text-cream border border-transparent",
  muted:
    "bg-cream-deep text-ink-soft border border-transparent",
  warning:
    "bg-amber-soft/40 text-amber border border-amber/30",
  active:
    "bg-sage text-cream border border-transparent",
};

/**
 * Chip — small interactive token. Used for:
 *   - chips of selectable answers in onboarding
 *   - tool-call status pills in the chat surface
 *   - ingredient/equipment tags
 */
export const Chip = React.forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  { className, variant = "default", children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[var(--radius-full)] px-3 py-1 text-sm font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta",
        variants[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});
