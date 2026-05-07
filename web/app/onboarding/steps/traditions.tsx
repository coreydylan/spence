"use client";

import * as React from "react";
import { BigQuestion } from "@/components/onboarding/big-question";
import { Input } from "@/components/primitives/input";
import { Button } from "@/components/primitives/button";
import { Chip } from "@/components/primitives/chip";

export interface Tradition {
  name: string;
  cadence: string;
  description?: string;
}

export interface TraditionsStepProps {
  initialValue?: Tradition[];
  onSubmit: (value: Tradition[]) => void;
  onSkip: () => void;
  bindCta?: (cta: React.ReactNode) => void;
}

const CADENCE_OPTIONS: { id: string; label: string }[] = [
  { id: "weekly:monday", label: "Mon" },
  { id: "weekly:tuesday", label: "Tue" },
  { id: "weekly:wednesday", label: "Wed" },
  { id: "weekly:thursday", label: "Thu" },
  { id: "weekly:friday", label: "Fri" },
  { id: "weekly:saturday", label: "Sat" },
  { id: "weekly:sunday", label: "Sun" },
];

const SUGGESTIONS: Tradition[] = [
  { name: "Friday pizza night", cadence: "weekly:friday" },
  { name: "Sunday roast", cadence: "weekly:sunday" },
  { name: "Taco Tuesday", cadence: "weekly:tuesday" },
];

export function TraditionsStep({
  initialValue = [],
  onSubmit,
  onSkip,
  bindCta,
}: TraditionsStepProps) {
  const [traditions, setTraditions] =
    React.useState<Tradition[]>(initialValue);
  const [draftName, setDraftName] = React.useState("");
  const [draftCadence, setDraftCadence] = React.useState("weekly:friday");

  const addTradition = (t?: Tradition) => {
    const tr =
      t ?? (draftName.trim() ? { name: draftName.trim(), cadence: draftCadence } : null);
    if (!tr) return;
    setTraditions((prev) => {
      if (prev.some((p) => p.name === tr.name)) return prev;
      return [...prev, tr];
    });
    if (!t) setDraftName("");
  };

  const remove = (i: number) =>
    setTraditions((prev) => prev.filter((_, idx) => idx !== i));

  React.useEffect(() => {
    bindCta?.(
      <div className="flex flex-col gap-2">
        <Button
          size="lg"
          onClick={() => onSubmit(traditions)}
          className="w-full"
        >
          {traditions.length === 0 ? "No traditions" : `Save ${traditions.length}`}
        </Button>
        <Button
          variant="ghost"
          size="md"
          onClick={onSkip}
          className="w-full"
        >
          Skip
        </Button>
      </div>,
    );
  }, [bindCta, traditions, onSubmit, onSkip]);

  return (
    <div className="pt-10 flex flex-col gap-8">
      <BigQuestion
        eyebrow="Standing meals"
        title="Any weekly traditions?"
        subhead="Friday pizza? Sunday roast? Taco Tuesday? Optional — I'll honor anything you tell me."
      />

      {traditions.length > 0 && (
        <div className="flex flex-col gap-2">
          {traditions.map((t, i) => (
            <div
              key={`${t.name}-${i}`}
              className="flex items-center justify-between rounded-[var(--radius-md)] border border-ink/8 bg-white/70 px-4 py-3"
            >
              <div className="flex flex-col">
                <span className="font-medium text-ink">{t.name}</span>
                <span className="text-xs text-ink-soft uppercase tracking-wider">
                  {t.cadence.replace(/^weekly:/, "")}
                </span>
              </div>
              <button
                type="button"
                onClick={() => remove(i)}
                className="text-sm text-ink-soft hover:text-amber"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-3 rounded-[var(--radius-lg)] bg-cream-deep/60 p-4">
        <Input
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          placeholder="e.g. Friday pizza"
          onKeyDown={(e) => {
            if (e.key === "Enter") addTradition();
          }}
        />
        <div className="flex flex-wrap gap-2">
          {CADENCE_OPTIONS.map((c) => (
            <Chip
              key={c.id}
              variant={draftCadence === c.id ? "selected" : "default"}
              onClick={() => setDraftCadence(c.id)}
            >
              {c.label}
            </Chip>
          ))}
        </div>
        <Button
          variant="outline"
          onClick={() => addTradition()}
          disabled={!draftName.trim()}
        >
          Add tradition
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-xs text-ink-soft uppercase tracking-wider">
          Common ones
        </p>
        <div className="flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <Chip
              key={s.name}
              variant={
                traditions.some((t) => t.name === s.name) ? "active" : "default"
              }
              onClick={() => addTradition(s)}
            >
              + {s.name}
            </Chip>
          ))}
        </div>
      </div>
    </div>
  );
}
