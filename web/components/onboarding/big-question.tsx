"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

interface Props {
  /** Big serif headline — the question itself. */
  title: string;
  /** Optional supporting copy — shorter, sans, ink-soft. */
  subhead?: string;
  /** Optional eyebrow / step name above the title. */
  eyebrow?: string;
  className?: string;
}

/**
 * BigQuestion — the shared header at the top of every onboarding step.
 * Big serif, calm subtitle, optional eyebrow. Mobile-first: 2xl on small,
 * 4xl on md+.
 */
export function BigQuestion({ title, subhead, eyebrow, className }: Props) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {eyebrow && (
        <p className="text-xs uppercase tracking-[0.18em] text-ink-soft/80 font-medium">
          {eyebrow}
        </p>
      )}
      <h1 className="font-serif text-3xl md:text-4xl leading-[1.1] tracking-tight text-ink">
        {title}
      </h1>
      {subhead && (
        <p className="text-base md:text-lg text-ink-soft leading-relaxed">
          {subhead}
        </p>
      )}
    </div>
  );
}
