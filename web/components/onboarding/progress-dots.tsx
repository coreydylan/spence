"use client";

import * as React from "react";
import { cn } from "@/lib/cn";
import type { StepTier } from "@/lib/onboarding-flow";

export interface ProgressGroup {
  tier: StepTier;
  /** Total dots in this tier. */
  total: number;
  /** Active dot index (0-based); -1 if this tier hasn't started yet. */
  index: number;
}

interface Props {
  groups: ProgressGroup[];
  /** Index of the currently-active tier (the rest are either past or future). */
  activeTier: StepTier;
}

/**
 * ProgressDots — small grouped dots at the top of each onboarding screen.
 * Each tier is its own cluster (separated by a thin gap) so the user feels
 * the chapter transition.
 */
export function ProgressDots({ groups, activeTier }: Props) {
  return (
    <div className="flex items-center justify-center gap-3 py-4">
      {groups
        .filter((g) => g.tier !== "done")
        .map((g, gi) => {
          const isPast = isTierBefore(g.tier, activeTier);
          const isActive = g.tier === activeTier;
          return (
            <React.Fragment key={`${String(g.tier)}-${gi}`}>
              <div className="flex items-center gap-1.5" aria-label={`tier ${String(g.tier)}`}>
                {Array.from({ length: g.total }).map((_, i) => {
                  const filled = isPast || (isActive && i <= g.index);
                  const current = isActive && i === g.index;
                  return (
                    <span
                      key={i}
                      className={cn(
                        "block rounded-full transition-all duration-300",
                        current
                          ? "h-2 w-6 bg-terracotta"
                          : filled
                            ? "h-2 w-2 bg-terracotta/70"
                            : "h-2 w-2 bg-ink/15",
                      )}
                    />
                  );
                })}
              </div>
              {gi < groups.filter((g) => g.tier !== "done").length - 1 && (
                <span className="h-px w-3 bg-ink/10" />
              )}
            </React.Fragment>
          );
        })}
    </div>
  );
}

function tierOrder(tier: StepTier): number {
  if (tier === 0) return 0;
  if (tier === 1) return 1;
  if (tier === "bulk") return 2;
  return 3;
}

function isTierBefore(a: StepTier, b: StepTier): boolean {
  return tierOrder(a) < tierOrder(b);
}
