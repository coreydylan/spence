import * as React from "react";
import { cn } from "@/lib/cn";

export type BadgeTone = "neutral" | "terracotta" | "sage" | "amber" | "ink";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

const tones: Record<BadgeTone, string> = {
  neutral: "bg-cream-deep text-ink-soft",
  terracotta: "bg-terracotta/12 text-terracotta",
  sage: "bg-sage/12 text-sage",
  amber: "bg-amber/12 text-amber",
  ink: "bg-ink text-cream",
};

/**
 * Badge — small static label. Use for category pills (cuisine, format, etc.).
 * Non-interactive; for clickable tokens use `Chip`.
 */
export function Badge({ className, tone = "neutral", ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[var(--radius-full)] px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide",
        tones[tone],
        className,
      )}
      {...rest}
    />
  );
}
