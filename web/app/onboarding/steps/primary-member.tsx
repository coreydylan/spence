"use client";

import * as React from "react";
import { BigQuestion } from "@/components/onboarding/big-question";
import { Input } from "@/components/primitives/input";
import { Button } from "@/components/primitives/button";
import { Chip } from "@/components/primitives/chip";
import { AGE_GROUP_CHOICES } from "@/lib/onboarding-flow";

export interface PrimaryMemberStepProps {
  initialValue?: { name: string; age_group?: string };
  onSubmit: (value: { name: string; age_group?: string }) => void;
  bindCta?: (cta: React.ReactNode) => void;
}

export function PrimaryMemberStep({
  initialValue,
  onSubmit,
  bindCta,
}: PrimaryMemberStepProps) {
  const [name, setName] = React.useState(initialValue?.name ?? "");
  const [ageGroup, setAgeGroup] = React.useState<string | undefined>(
    initialValue?.age_group ?? "adult",
  );

  const submit = React.useCallback(() => {
    if (name.trim()) onSubmit({ name: name.trim(), age_group: ageGroup });
  }, [name, ageGroup, onSubmit]);

  React.useEffect(() => {
    bindCta?.(
      <Button
        size="lg"
        onClick={submit}
        disabled={!name.trim()}
        className="w-full"
      >
        Continue
      </Button>,
    );
  }, [bindCta, submit, name]);

  return (
    <div className="pt-10 flex flex-col gap-8">
      <BigQuestion
        eyebrow="Step 2"
        title="And what's your name?"
        subhead="So I know who I'm talking to. I'll learn the rest of your house in a minute."
      />

      <div className="flex flex-col gap-5">
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="First name"
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />

        <div className="flex flex-col gap-2">
          <p className="text-xs text-ink-soft uppercase tracking-wider">
            Age group (optional)
          </p>
          <div className="flex flex-wrap gap-2">
            {AGE_GROUP_CHOICES.map((c) => (
              <Chip
                key={c.id}
                variant={ageGroup === c.id ? "selected" : "default"}
                onClick={() => setAgeGroup(c.id)}
              >
                {c.label}
              </Chip>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
