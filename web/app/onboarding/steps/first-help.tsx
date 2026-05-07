"use client";

import * as React from "react";
import { BigQuestion } from "@/components/onboarding/big-question";
import { CardChoice } from "@/components/onboarding/card-choice";
import { FIRST_HELP_CHOICES } from "@/lib/onboarding-flow";

export interface FirstHelpStepProps {
  initialValue?: string;
  onSubmit: (value: string) => void;
  bindCta?: (cta: React.ReactNode) => void;
}

export function FirstHelpStep({
  initialValue,
  onSubmit,
  bindCta,
}: FirstHelpStepProps) {
  React.useEffect(() => {
    bindCta?.(null);
  }, [bindCta]);

  return (
    <div className="pt-10 flex flex-col gap-8">
      <BigQuestion
        eyebrow="Step 5 of 5 · the basics"
        title="What's most useful right now?"
        subhead="Pick one. We can do all of it eventually."
      />

      <div className="flex flex-col gap-3">
        {FIRST_HELP_CHOICES.map((c) => (
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
