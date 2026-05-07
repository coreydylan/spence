"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

export type TimelineStepStatus = "completed" | "active" | "pending";

export interface TimelineStep {
  task_id: string;
  /** Wall-clock time the step is/was scheduled to start, e.g. "17:25". */
  scheduled_at?: string;
  title: string;
  status: TimelineStepStatus;
  est_min?: number;
  /** Member working on it (for active/completed). */
  member_display_name?: string;
}

export interface RecipeTimelineProps {
  steps: TimelineStep[];
  className?: string;
}

/**
 * RecipeTimeline — vertical list of every step in the recipe, with
 * status icons. The active step gets a terracotta marker; completed
 * steps a sage check; pending steps a faint open dot.
 *
 * Designed to be glanceable: 18px body, plenty of whitespace, the active
 * row pinned visually to the current task above.
 */
export function RecipeTimeline({ steps, className }: RecipeTimelineProps) {
  if (steps.length === 0) return null;
  return (
    <section
      aria-label="Recipe steps"
      className={cn(
        "rounded-[var(--radius-lg)] bg-ink-surface px-5 py-4",
        className,
      )}
    >
      <p className="text-[11px] uppercase tracking-[0.18em] text-cream-faint mb-4 font-medium">
        Recipe steps
      </p>
      <ol className="space-y-3">
        {steps.map((step) => (
          <li
            key={step.task_id}
            data-status={step.status}
            className={cn(
              "flex items-start gap-3 text-base leading-snug",
              step.status === "active" && "text-cream-dim",
              step.status === "completed" && "text-cream-faint",
              step.status === "pending" && "text-cream-dim/70",
            )}
          >
            <StatusIcon status={step.status} />
            <span className="font-mono text-xs text-cream-faint w-12 pt-0.5 shrink-0">
              {step.scheduled_at ?? ""}
            </span>
            <div className="flex-1 min-w-0">
              <p
                className={cn(
                  "truncate",
                  step.status === "completed" && "line-through decoration-cream-faint/40",
                  step.status === "active" && "text-terracotta-soft font-medium",
                )}
              >
                {step.title}
              </p>
              {(step.member_display_name || step.est_min != null) && (
                <p className="text-xs text-cream-faint mt-0.5">
                  {step.member_display_name
                    ? `${step.member_display_name}`
                    : null}
                  {step.member_display_name && step.est_min != null
                    ? " · "
                    : null}
                  {step.est_min != null ? `${step.est_min} min` : null}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function StatusIcon({ status }: { status: TimelineStepStatus }) {
  if (status === "completed") {
    return (
      <span
        aria-label="completed"
        className="h-5 w-5 shrink-0 rounded-full bg-sage/20 flex items-center justify-center mt-0.5"
      >
        <svg
          viewBox="0 0 24 24"
          className="h-3 w-3 text-sage-soft"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          aria-hidden
        >
          <polyline points="4 13 9 18 20 6" />
        </svg>
      </span>
    );
  }
  if (status === "active") {
    return (
      <span
        aria-label="active"
        className="h-5 w-5 shrink-0 rounded-full bg-terracotta flex items-center justify-center mt-0.5"
      >
        <span className="h-2 w-2 rounded-full bg-cream animate-pulse-dot" />
      </span>
    );
  }
  return (
    <span
      aria-label="pending"
      className="h-5 w-5 shrink-0 rounded-full border border-cream-faint/30 mt-0.5"
    />
  );
}
