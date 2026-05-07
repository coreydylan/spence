"use client";

import * as React from "react";
import { BigQuestion } from "@/components/onboarding/big-question";
import { Button } from "@/components/primitives/button";
import { EQUIPMENT_CHOICES } from "@/lib/onboarding-flow";
import { cn } from "@/lib/cn";

export interface EquipmentGridStepProps {
  initialValue?: string[];
  onSubmit: (value: string[]) => void;
  onSkip: () => void;
  bindCta?: (cta: React.ReactNode) => void;
}

export function EquipmentGridStep({
  initialValue = ["oven", "stovetop"],
  onSubmit,
  onSkip,
  bindCta,
}: EquipmentGridStepProps) {
  const [selected, setSelected] = React.useState<string[]>(initialValue);

  const toggle = (id: string) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  React.useEffect(() => {
    bindCta?.(
      <div className="flex flex-col gap-2">
        <Button
          size="lg"
          onClick={() => onSubmit(selected)}
          className="w-full"
        >
          {selected.length === 0 ? "None of these" : `Save ${selected.length}`}
        </Button>
        <Button
          variant="ghost"
          size="md"
          onClick={onSkip}
          className="w-full"
        >
          Skip for now
        </Button>
      </div>,
    );
  }, [bindCta, selected, onSubmit, onSkip]);

  return (
    <div className="pt-10 flex flex-col gap-8">
      <BigQuestion
        eyebrow="Your gear"
        title="What do you cook with?"
        subhead="Tap everything you've got. I won't suggest a sous-vide recipe if you don't have one."
      />

      <div className="grid grid-cols-2 gap-2">
        {EQUIPMENT_CHOICES.map((c) => {
          const isSelected = selected.includes(c.id);
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => toggle(c.id)}
              className={cn(
                "min-h-[56px] px-4 rounded-[var(--radius-md)] border text-left text-sm font-medium transition-all",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta",
                isSelected
                  ? "border-sage bg-sage/10 text-sage ring-1 ring-sage/30"
                  : "border-ink/8 bg-white/70 text-ink hover:bg-white",
              )}
              aria-pressed={isSelected}
            >
              {c.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
