"use client";

import * as React from "react";
import { BigQuestion } from "@/components/onboarding/big-question";
import { CardChoice } from "@/components/onboarding/card-choice";
import { COOK_FREQUENCY_CHOICES } from "@/lib/onboarding-flow";

export interface CookFrequencyStepProps {
  initialValue?: string;
  onSubmit: (value: string) => void;
  bindCta?: (cta: React.ReactNode) => void;
}

export function CookFrequencyStep({
  initialValue,
  onSubmit,
  bindCta,
}: CookFrequencyStepProps) {
  React.useEffect(() => {
    bindCta?.(null);
  }, [bindCta]);

  return (
    <div className="pt-10 flex flex-col gap-8">
      <BigQuestion
        eyebrow="How often"
        title="Do you cook most nights, sometimes, or rarely?"
        subhead="Be honest. I'll plan around how you actually live."
      />

      <div className="flex flex-col gap-3">
        {COOK_FREQUENCY_CHOICES.map((c) => (
          <CardChoice
            key={c.id}
            label={c.label}
            hint={c.hint}
            selected={initialValue === c.id}
            onClick={() => onSubmit(c.id)}
          />
        ))}
      </div>
    </div>
  );
}
