"use client";

import * as React from "react";
import { BigQuestion } from "@/components/onboarding/big-question";
import { Textarea } from "@/components/primitives/input";
import { Button } from "@/components/primitives/button";

export interface PantryPasteStepProps {
  initialValue?: string;
  onSubmit: (value: string) => void;
  onSkip: () => void;
  bindCta?: (cta: React.ReactNode) => void;
}

const PLACEHOLDER = `chickpeas, lentils, rice, pasta
olive oil, soy sauce, miso, tahini
garlic, onions, lemons
canned tomatoes, coconut milk
parmesan, feta, plain yogurt`;

export function PantryPasteStep({
  initialValue = "",
  onSubmit,
  onSkip,
  bindCta,
}: PantryPasteStepProps) {
  const [text, setText] = React.useState(initialValue);

  const submit = React.useCallback(() => {
    if (text.trim()) onSubmit(text.trim());
  }, [text, onSubmit]);

  React.useEffect(() => {
    bindCta?.(
      <div className="flex flex-col gap-2">
        <Button
          size="lg"
          onClick={submit}
          disabled={!text.trim()}
          className="w-full"
        >
          Save pantry
        </Button>
        <Button
          variant="ghost"
          size="md"
          onClick={onSkip}
          className="w-full"
        >
          I'll do this later
        </Button>
      </div>,
    );
  }, [bindCta, submit, onSkip, text]);

  return (
    <div className="pt-10 flex flex-col gap-8">
      <BigQuestion
        eyebrow="Bulk paste"
        title="What's in there right now?"
        subhead="Just type or paste — comma-separated, line-separated, doesn't matter. I'll sort it."
      />

      <Textarea
        autoFocus
        rows={10}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={PLACEHOLDER}
        className="font-mono text-sm"
      />
    </div>
  );
}
