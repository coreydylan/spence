"use client";

import * as React from "react";
import { OnboardingQuestionCard } from "@/components/chef/onboarding-question-card";
import { mcpClient } from "@/lib/mcp";
import type { ChefQuestion } from "@/lib/mcp";

interface QuestionCalloutProps {
  question: ChefQuestion;
}

/**
 * QuestionCallout — inline "Question for you" card on /today.
 *
 * Wraps <OnboardingQuestionCard> with a heading row and a network call to
 * `household_onboarding_answer` so the user can answer right from the brief.
 *
 * Local optimistic state hides the card after submission; a refresh re-pulls
 * the next question (or none) from the brief.
 */
export function QuestionCallout({ question }: QuestionCalloutProps) {
  const [submitted, setSubmitted] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  if (submitted) {
    return (
      <section className="flex flex-col gap-3 animate-fade-up" aria-label="Question for you">
        <h3 className="text-xs uppercase tracking-[0.18em] text-ink-soft font-semibold">
          Question for you
        </h3>
        <p className="text-sm text-sage italic">Got it — thanks. I&rsquo;ll factor that in.</p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3" aria-label="Question for you">
      <h3 className="text-xs uppercase tracking-[0.18em] text-ink-soft font-semibold">
        ▷ Question for you
      </h3>
      <OnboardingQuestionCard
        question={question}
        onAnswer={async ({ question_id, answer }) => {
          try {
            await mcpClient("household_onboarding_answer", {
              question_id,
              answer,
            });
            setSubmitted(true);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }}
      />
      {error && (
        <p className="text-xs text-amber">
          Couldn&rsquo;t save: {error}. Try again from the chat.
        </p>
      )}
    </section>
  );
}
