"use client";

import * as React from "react";
import { BigQuestion } from "@/components/onboarding/big-question";
import { Input } from "@/components/primitives/input";
import { Button } from "@/components/primitives/button";

export interface HouseholdNameStepProps {
  initialValue?: string;
  onSubmit: (value: string) => void;
  /** Bind the CTA into the StepShell's sticky region. */
  bindCta?: (cta: React.ReactNode) => void;
}

const SUGGESTIONS = ["The Bruins", "Casa Verde", "Apartment 4B", "Home base"];

export function HouseholdNameStep({
  initialValue = "",
  onSubmit,
  bindCta,
}: HouseholdNameStepProps) {
  const [value, setValue] = React.useState(initialValue);

  const submit = React.useCallback(() => {
    const v = value.trim();
    if (v) onSubmit(v);
  }, [value, onSubmit]);

  React.useEffect(() => {
    bindCta?.(
      <Button
        size="lg"
        onClick={submit}
        disabled={!value.trim()}
        className="w-full"
      >
        Continue
      </Button>,
    );
  }, [bindCta, submit, value]);

  return (
    <div className="pt-10 flex flex-col gap-8">
      <BigQuestion
        eyebrow="Step 1"
        title="What should I call your household?"
        subhead="A nickname I can use when I refer to your home. You can change it later."
      />

      <div className="flex flex-col gap-4">
        <Input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="e.g. The Bruins"
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />

        <div className="flex flex-col gap-2">
          <p className="text-xs text-ink-soft uppercase tracking-wider">
            Or pick one
          </p>
          <div className="flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setValue(s);
                }}
                className="px-4 h-10 rounded-[var(--radius-full)] bg-white/70 border border-ink/10 text-sm text-ink hover:bg-white transition-colors"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
