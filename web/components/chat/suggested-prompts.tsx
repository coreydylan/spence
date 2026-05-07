"use client";

import * as React from "react";
import { Chip } from "@/components/primitives/chip";
import { cn } from "@/lib/cn";
import { tapHaptic } from "@/lib/haptics";

export interface SuggestedPrompt {
  id: string;
  text: string;
  /** Optional icon (emoji or react node) shown before the text. */
  icon?: React.ReactNode;
}

interface SuggestedPromptsProps {
  prompts?: SuggestedPrompt[];
  onPick: (text: string) => void;
  className?: string;
  /** Headline above the chips. Defaults to a Spence intro. */
  headline?: string;
  subhead?: string;
}

export const DEFAULT_PROMPTS: SuggestedPrompt[] = [
  { id: "plan_week", text: "Plan me dinners for the week" },
  { id: "tonight", text: "What should I cook tonight?" },
  { id: "pantry", text: "Help me use up what's in my pantry" },
  { id: "guests", text: "Plan a dinner for guests on Friday" },
];

/**
 * SuggestedPrompts — empty-state surface for the chat. Centered serif
 * headline + a row of clickable starter chips. Tapping a chip submits the
 * prompt and replaces this component with the live conversation.
 */
export function SuggestedPrompts({
  prompts = DEFAULT_PROMPTS,
  onPick,
  className,
  headline = "Hi. I'm Spence.",
  subhead = "Tell me what you need. I'll figure out the rest.",
}: SuggestedPromptsProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center px-6 py-12 gap-6 max-w-2xl mx-auto animate-fade-up",
        className,
      )}
    >
      <div className="flex flex-col gap-2">
        <h1 className="font-serif text-4xl sm:text-5xl text-ink dark:text-cream tracking-tight">
          {headline}
        </h1>
        <p className="text-ink-soft dark:text-cream/60 text-lg">{subhead}</p>
      </div>
      <div className="flex flex-wrap justify-center gap-2 max-w-xl">
        {prompts.map((p) => (
          <Chip
            key={p.id}
            variant="default"
            onClick={() => {
              tapHaptic();
              onPick(p.text);
            }}
            className="text-sm sm:text-base"
          >
            {p.icon && <span>{p.icon}</span>}
            {p.text}
          </Chip>
        ))}
      </div>
    </div>
  );
}
