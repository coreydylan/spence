"use client";

import * as React from "react";
import { BigQuestion } from "@/components/onboarding/big-question";
import { SIZE_CHOICES } from "@/lib/onboarding-flow";
import { cn } from "@/lib/cn";

export interface SizeStepProps {
  initialValue?: string;
  onSubmit: (value: string) => void;
  bindCta?: (cta: React.ReactNode) => void;
}

export function SizeStep({ initialValue, onSubmit, bindCta }: SizeStepProps) {
  React.useEffect(() => {
    // Tap-to-advance — no sticky CTA.
    bindCta?.(null);
  }, [bindCta]);

  return (
    <div className="pt-10 flex flex-col gap-10">
      <BigQuestion
        eyebrow="Step 4"
        title="How many adults eat together?"
        subhead="Just adults for now — we'll add kids in the next step."
      />

      <div className="grid grid-cols-5 gap-3">
        {SIZE_CHOICES.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onSubmit(c.id)}
            className={cn(
              "aspect-square rounded-[var(--radius-lg)] border bg-white/70 hover:bg-white transition-all",
              "flex items-center justify-center font-serif text-3xl text-ink",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta",
              initialValue === c.id
                ? "border-sage ring-2 ring-sage/40 bg-white"
                : "border-ink/8 shadow-[var(--shadow-soft)]",
            )}
            aria-label={`${c.label} adults`}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}
