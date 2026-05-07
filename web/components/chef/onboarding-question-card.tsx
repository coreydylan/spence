"use client";

import * as React from "react";
import { Card, CardContent, CardTitle } from "@/components/primitives/card";
import { Chip } from "@/components/primitives/chip";
import { Button } from "@/components/primitives/button";
import { Textarea } from "@/components/primitives/input";

interface OnboardingQuestion {
  id?: string;
  /** Some upstream callers send `prompt`, others (the worker) send `question_text`. Either is fine. */
  prompt?: string;
  question_text?: string;
  kind?: string;
  choices?: { id: string; label: string }[];
  tier?: number;
  free_text_allowed?: boolean;
}

interface Props {
  question: OnboardingQuestion;
  onAnswer?: (answer: { question_id: string; answer: unknown }) => void;
}

/**
 * OnboardingQuestionCard — full-width card rendered inline in the chat when
 * the chef-status-check returns an onboarding question. Renders different
 * input shapes depending on question.kind.
 *
 * Phase 1: a single chip variant + a free-text fallback. The full set
 * (multi-choice, photo upload, etc.) is wired in Phase 2's onboarding flow.
 */
export function OnboardingQuestionCard({ question, onAnswer }: Props) {
  const [text, setText] = React.useState("");
  const [picked, setPicked] = React.useState<string[]>([]);

  const id = question.id ?? question.kind ?? "unknown";
  // Worker sends taxonomy kinds like "tier_0_household_name". Our render kinds
  // are "free_text" | "single_choice" | "multi_choice". Phase 1 only emits
  // single_choice (when choices are present) or free_text. Multi-choice is
  // wired in Phase 2 onboarding.
  const renderKind: "free_text" | "single_choice" | "multi_choice" = (
    question.kind === "multi_choice"
      ? "multi_choice"
      : question.choices && question.choices.length > 0
        ? "single_choice"
        : "free_text"
  );
  const promptText = question.prompt ?? question.question_text ?? "(question)";

  const submit = (answer: unknown) => {
    onAnswer?.({ question_id: id, answer });
  };

  return (
    <Card variant="raised" className="w-full max-w-xl animate-fade-up">
      <CardContent className="p-6 flex flex-col gap-4">
        <CardTitle className="text-xl">{promptText}</CardTitle>

        {renderKind === "single_choice" && question.choices && (
          <div className="flex flex-wrap gap-2">
            {question.choices.map((c) => (
              <Chip
                key={c.id}
                variant={picked[0] === c.id ? "selected" : "default"}
                onClick={() => {
                  setPicked([c.id]);
                  submit(c.id);
                }}
              >
                {c.label}
              </Chip>
            ))}
          </div>
        )}

        {renderKind === "multi_choice" && question.choices && (
          <>
            <div className="flex flex-wrap gap-2">
              {question.choices.map((c) => (
                <Chip
                  key={c.id}
                  variant={picked.includes(c.id) ? "selected" : "default"}
                  onClick={() => {
                    setPicked((prev) =>
                      prev.includes(c.id)
                        ? prev.filter((x) => x !== c.id)
                        : [...prev, c.id],
                    );
                  }}
                >
                  {c.label}
                </Chip>
              ))}
            </div>
            <div>
              <Button onClick={() => submit(picked)} disabled={picked.length === 0}>
                Save
              </Button>
            </div>
          </>
        )}

        {renderKind === "free_text" && (
          <>
            <Textarea
              rows={3}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Type your answer…"
            />
            <div>
              <Button onClick={() => submit(text)} disabled={!text.trim()}>
                Send
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
