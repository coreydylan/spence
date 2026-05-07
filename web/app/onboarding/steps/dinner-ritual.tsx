"use client";

import * as React from "react";
import { BigQuestion } from "@/components/onboarding/big-question";
import { CardChoice } from "@/components/onboarding/card-choice";
import { DINNER_RITUAL_CHOICES } from "@/lib/onboarding-flow";

export interface DinnerRitualStepProps {
  initialValue?: string;
  onSubmit: (value: string) => void;
  bindCta?: (cta: React.ReactNode) => void;
}

const GLYPHS: Record<string, string> = {
  table: "🍽",
  tv: "📺",
  desk: "💻",
  varies: "✨",
};

export function DinnerRitualStep({
  initialValue,
  onSubmit,
  bindCta,
}: DinnerRitualStepProps) {
  React.useEffect(() => {
    bindCta?.(null);
  }, [bindCta]);

  return (
    <div className="pt-10 flex flex-col gap-8">
      <BigQuestion
        eyebrow="The most important question"
        title="When you say dinner, what does it usually look like?"
        subhead="No wrong answer — I'll set the cooking rhythm to match."
      />

      <div className="flex flex-col gap-3">
        {DINNER_RITUAL_CHOICES.map((c) => (
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
