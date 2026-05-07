"use client";

import * as React from "react";
import { BigQuestion } from "@/components/onboarding/big-question";
import { Chip } from "@/components/primitives/chip";
import { Textarea } from "@/components/primitives/input";
import { Button } from "@/components/primitives/button";
import { AVOIDANCE_CHOICES } from "@/lib/onboarding-flow";

export interface AvoidancesValue {
  tags: string[];
  free_text: string;
}

export interface AvoidancesStepProps {
  initialValue?: AvoidancesValue;
  onSubmit: (value: AvoidancesValue) => void;
  bindCta?: (cta: React.ReactNode) => void;
}

export function AvoidancesStep({
  initialValue,
  onSubmit,
  bindCta,
}: AvoidancesStepProps) {
  const [tags, setTags] = React.useState<string[]>(initialValue?.tags ?? []);
  const [text, setText] = React.useState(initialValue?.free_text ?? "");

  const toggle = (id: string) => {
    setTags((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  React.useEffect(() => {
    bindCta?.(
      <Button
        size="lg"
        onClick={() => onSubmit({ tags, free_text: text.trim() })}
        className="w-full"
      >
        {tags.length === 0 && !text.trim() ? "Nothing to avoid" : "Continue"}
      </Button>,
    );
  }, [bindCta, tags, text, onSubmit]);

  return (
    <div className="pt-10 flex flex-col gap-8">
      <BigQuestion
        eyebrow="Anything off-limits?"
        title="What can't anyone in the house eat?"
        subhead="Allergies, dietary patterns, hard avoidances. Tap any that apply."
      />

      <div className="flex flex-wrap gap-2">
        {AVOIDANCE_CHOICES.map((c) => (
          <Chip
            key={c.id}
            variant={tags.includes(c.id) ? "selected" : "default"}
            onClick={() => toggle(c.id)}
          >
            {c.label}
          </Chip>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-xs text-ink-soft uppercase tracking-wider">
          Anything else
        </p>
        <Textarea
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. mushrooms, raw onion, super spicy"
        />
      </div>
    </div>
  );
}
