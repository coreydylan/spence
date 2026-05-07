"use client";

import * as React from "react";
import { BigQuestion } from "@/components/onboarding/big-question";
import { Button } from "@/components/primitives/button";

export interface FinalStepProps {
  /** Called when the user accepts the chef's offer to draft a week. */
  onDraftWeek: () => void;
  /** Called when the user wants to take a look around first. */
  onJustChat: () => void;
  bindCta?: (cta: React.ReactNode) => void;
}

export function FinalStep({
  onDraftWeek,
  onJustChat,
  bindCta,
}: FinalStepProps) {
  React.useEffect(() => {
    bindCta?.(
      <div className="flex flex-col gap-2">
        <Button
          size="lg"
          onClick={onDraftWeek}
          className="w-full"
        >
          Yes, draft my week
        </Button>
        <Button
          variant="ghost"
          size="md"
          onClick={onJustChat}
          className="w-full"
        >
          Let me look around first
        </Button>
      </div>,
    );
  }, [bindCta, onDraftWeek, onJustChat]);

  return (
    <div className="pt-16 flex flex-col gap-8 items-center text-center">
      <span className="text-5xl" aria-hidden>🍳</span>
      <BigQuestion
        eyebrow="We're set"
        title="Got it. Want me to draft a week of dinners?"
        subhead="I'll use what you've told me to lay out 4–7 dinners. You can swap, skip, or rewrite anything."
        className="items-center text-center"
      />
    </div>
  );
}
