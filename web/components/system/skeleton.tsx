import * as React from "react";
import { cn } from "@/lib/cn";

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "line" | "block" | "card" | "circle";
  /** Optional explicit width — for `line` variant. */
  width?: string;
  /** Optional explicit height. */
  height?: string;
}

/**
 * Skeleton — a terracotta-tinted shimmering placeholder.
 *
 * Variants:
 *   line   — single text line, default 1em tall
 *   block  — generic rectangle
 *   card   — full-card placeholder (use w/ Card layout)
 *   circle — round avatar/dot
 *
 * Respects `prefers-reduced-motion` (animation is css-only via `animate-shimmer`,
 * and the global stylesheet disables it under reduced motion).
 */
export function Skeleton({
  className,
  variant = "block",
  width,
  height,
  style,
  ...rest
}: SkeletonProps) {
  return (
    <div
      aria-busy="true"
      aria-hidden="true"
      className={cn(
        "bg-cream-deep dark:bg-ink-soft/30 rounded-[var(--radius-md)] animate-shimmer overflow-hidden",
        variant === "line" && "h-4 rounded-[var(--radius-sm)]",
        variant === "circle" && "rounded-full",
        variant === "card" && "rounded-[var(--radius-lg)] h-40 w-full",
        className,
      )}
      style={{ width, height, ...style }}
      {...rest}
    />
  );
}

/**
 * SkeletonCard — the canonical "loading meal/brief/recipe" placeholder.
 * Renders a hero gradient block + 2 lines + a row of pills.
 */
export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius-lg)] border border-ink/5 bg-white/60 dark:bg-ink/30 shadow-[var(--shadow-soft)] overflow-hidden",
        className,
      )}
    >
      <Skeleton className="h-24 rounded-none" />
      <div className="p-5 flex flex-col gap-3">
        <Skeleton variant="line" className="w-2/3 h-5" />
        <div className="flex gap-2">
          <Skeleton variant="line" width="3.5rem" />
          <Skeleton variant="line" width="4rem" />
          <Skeleton variant="line" width="3rem" />
        </div>
        <Skeleton variant="line" className="w-1/2" />
      </div>
    </div>
  );
}

/** SkeletonList — a stack of N SkeletonCards. */
export function SkeletonList({ count = 3, className }: { count?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}
