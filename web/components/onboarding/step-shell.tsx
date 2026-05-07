"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

interface Props {
  children: React.ReactNode;
  /** Top-left back action; if undefined, no back button is rendered. */
  onBack?: () => void;
  /** Optional skip action (top-right). */
  onSkip?: () => void;
  /** Animation direction key. Changing this remounts the slide animation. */
  animationKey: string;
  /** Optional sticky CTA region rendered fixed at the bottom (mobile-friendly). */
  cta?: React.ReactNode;
  /** Disable the slide-in animation (used by Storybook for stable snapshots). */
  noAnimate?: boolean;
}

/**
 * StepShell — the page chrome around each onboarding step.
 *
 * - Full viewport height, vertical layout, bottom-pinned CTA.
 * - Animated slide-in on mount: each new step keys off `animationKey` so the
 *   shell remounts and re-runs the entry transition.
 * - Optional back + skip buttons at the top.
 */
export function StepShell({
  children,
  onBack,
  onSkip,
  animationKey,
  cta,
  noAnimate,
}: Props) {
  return (
    <div className="flex flex-col min-h-dvh">
      {/* Top bar — back + skip */}
      <div className="flex items-center justify-between px-4 pt-4">
        <div className="min-w-[44px]">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-1 h-10 px-3 rounded-[var(--radius-full)] text-ink-soft hover:bg-cream-deep transition-colors text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta"
              aria-label="Back"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                aria-hidden
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M10 12 L6 8 L10 4" />
              </svg>
              Back
            </button>
          )}
        </div>
        <div>
          {onSkip && (
            <button
              type="button"
              onClick={onSkip}
              className="h-10 px-3 rounded-[var(--radius-full)] text-ink-soft hover:bg-cream-deep transition-colors text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta"
            >
              Skip
            </button>
          )}
        </div>
      </div>

      {/* Animated body */}
      <div
        key={animationKey}
        className={cn(
          "flex-1 px-5 md:px-8 pb-32 max-w-xl w-full mx-auto",
          !noAnimate && "animate-step-slide",
        )}
      >
        {children}
      </div>

      {/* Sticky CTA */}
      {cta && (
        <div className="fixed inset-x-0 bottom-0 z-30 bg-gradient-to-t from-cream via-cream/95 to-cream/0 pt-6 pb-5 px-5">
          <div className="max-w-xl mx-auto">{cta}</div>
        </div>
      )}
    </div>
  );
}
