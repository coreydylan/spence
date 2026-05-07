"use client";

import * as React from "react";
import { BigQuestion } from "@/components/onboarding/big-question";
import { CardChoice } from "@/components/onboarding/card-choice";
import { PANTRY_INTAKE_CHOICES } from "@/lib/onboarding-flow";

export interface PantryIntakeStepProps {
  initialValue?: string;
  onSubmit: (value: string) => void;
  bindCta?: (cta: React.ReactNode) => void;
}

const GLYPHS: Record<string, string> = {
  bulk: "📋",
  photo: "📷",
  gradual: "🌿",
};

export function PantryIntakeStep({
  initialValue,
  onSubmit,
  bindCta,
}: PantryIntakeStepProps) {
  React.useEffect(() => {
    bindCta?.(null);
  }, [bindCta]);

  return (
    <div className="pt-10 flex flex-col gap-8">
      <BigQuestion
        eyebrow="Your pantry"
        title="How should we capture what's in your kitchen?"
        subhead="More info now means better suggestions sooner — but you can always do this later."
      />

      <div className="flex flex-col gap-3">
        {PANTRY_INTAKE_CHOICES.map((c) => (
          <CardChoice
            key={c.id}
            label={c.label}
            hint={c.hint}
            glyph={GLYPHS[c.id]}
            selected={initialValue === c.id}
            onClick={() => onSubmit(c.id)}
          />
        ))}
      </div>
    </div>
  );
}
