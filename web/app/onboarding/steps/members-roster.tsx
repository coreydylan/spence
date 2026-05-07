"use client";

import * as React from "react";
import { BigQuestion } from "@/components/onboarding/big-question";
import { Input } from "@/components/primitives/input";
import { Button } from "@/components/primitives/button";
import { Chip } from "@/components/primitives/chip";
import { AGE_GROUP_CHOICES } from "@/lib/onboarding-flow";

export interface Member {
  name: string;
  age_group?: string;
}

export interface MembersRosterStepProps {
  initialValue?: Member[];
  onSubmit: (value: Member[]) => void;
  bindCta?: (cta: React.ReactNode) => void;
}

export function MembersRosterStep({
  initialValue = [],
  onSubmit,
  bindCta,
}: MembersRosterStepProps) {
  const [members, setMembers] = React.useState<Member[]>(initialValue);
  const [draftName, setDraftName] = React.useState("");
  const [draftAge, setDraftAge] = React.useState<string>("adult");

  const addMember = () => {
    if (!draftName.trim()) return;
    setMembers((prev) => [...prev, { name: draftName.trim(), age_group: draftAge }]);
    setDraftName("");
  };

  const removeMember = (i: number) => {
    setMembers((prev) => prev.filter((_, idx) => idx !== i));
  };

  React.useEffect(() => {
    bindCta?.(
      <Button
        size="lg"
        onClick={() => onSubmit(members)}
        className="w-full"
      >
        {members.length === 0 ? "It's just me" : `Continue with ${members.length}`}
      </Button>,
    );
  }, [bindCta, members, onSubmit]);

  return (
    <div className="pt-10 flex flex-col gap-8">
      <BigQuestion
        eyebrow="Who else is here"
        title="Anyone else eating with you?"
        subhead="Roommates, partner, kids, regular guests. Skip if it's just you."
      />

      {members.length > 0 && (
        <div className="flex flex-col gap-2">
          {members.map((m, i) => (
            <div
              key={`${m.name}-${i}`}
              className="flex items-center justify-between rounded-[var(--radius-md)] border border-ink/8 bg-white/70 px-4 py-3"
            >
              <div className="flex flex-col">
                <span className="font-medium text-ink">{m.name}</span>
                {m.age_group && (
                  <span className="text-xs text-ink-soft uppercase tracking-wider">
                    {m.age_group}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => removeMember(i)}
                className="text-sm text-ink-soft hover:text-amber"
                aria-label={`Remove ${m.name}`}
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
          placeholder="Their name"
          onKeyDown={(e) => {
            if (e.key === "Enter") addMember();
          }}
        />
        <div className="flex flex-wrap gap-2">
          {AGE_GROUP_CHOICES.map((c) => (
            <Chip
              key={c.id}
              variant={draftAge === c.id ? "selected" : "default"}
              onClick={() => setDraftAge(c.id)}
            >
              {c.label}
            </Chip>
          ))}
        </div>
        <Button
          variant="outline"
          onClick={addMember}
          disabled={!draftName.trim()}
        >
          Add person
        </Button>
      </div>
    </div>
  );
}
