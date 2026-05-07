"use client";

import * as React from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardSubtitle, CardTitle } from "@/components/primitives/card";
import { Button } from "@/components/primitives/button";
import { Badge } from "@/components/primitives/badge";
import { Chip } from "@/components/primitives/chip";
import type { ChefStatus, HouseholdSignals } from "@/lib/mcp";
import { tapHaptic } from "@/lib/haptics";

interface OnboardingSectionProps {
  status: ChefStatus | null;
  signals: HouseholdSignals | null;
}

/**
 * OnboardingSection — re-run onboarding button + an expanded "what Spence
 * knows about you" digest. The digest is the human-readable summary of the
 * personality.summary + traditions + avoidances + equipment.
 */
export function OnboardingSection({ status, signals }: OnboardingSectionProps) {
  const [expanded, setExpanded] = React.useState(false);

  const summary = signals?.personality?.summary ?? "Still calibrating; come back after a few meals.";
  const traditions = signals?.traditions ?? [];
  const dietary = signals?.avoidances?.dietary ?? [];
  const allergies = signals?.avoidances?.allergies ?? [];
  const dislikes = signals?.avoidances?.dislikes ?? [];
  const equipment = signals?.equipment_available ?? [];
  const pantryTop = signals?.pantry_top ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">Onboarding</CardTitle>
        <CardSubtitle>What Spence has figured out so far.</CardSubtitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          {status?.onboarding?.tier_0_done ? (
            <Badge tone="sage">tier 0 complete</Badge>
          ) : (
            <Badge tone="amber">tier 0 in progress</Badge>
          )}
          {status?.onboarding?.tier_1_done && <Badge tone="sage">tier 1 complete</Badge>}
          <span className="text-xs text-ink-soft dark:text-cream/60 ml-auto">
            {status?.onboarding?.completion_pct ?? 0}% complete
          </span>
        </div>
        <p className="text-ink dark:text-cream leading-relaxed font-serif italic">
          &ldquo;{summary}&rdquo;
        </p>

        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-sm text-terracotta hover:text-terracotta/80 self-start font-medium"
          aria-expanded={expanded}
        >
          {expanded ? "Hide details" : "What does Spence know?"}
        </button>

        {expanded && (
          <div className="flex flex-col gap-4 animate-fade-up">
            <DigestBlock title="Traditions">
              {traditions.length === 0 ? (
                <span className="text-ink-soft italic text-sm">None recorded.</span>
              ) : (
                <ul className="text-sm flex flex-col gap-1">
                  {traditions.map((t, i) => (
                    <li key={i} className="text-ink dark:text-cream">
                      <span className="font-medium">{t.name}</span>
                      <span className="text-ink-soft dark:text-cream/60"> · {t.cadence}</span>
                    </li>
                  ))}
                </ul>
              )}
            </DigestBlock>

            <DigestBlock title="Avoidances">
              <div className="flex flex-wrap gap-1.5">
                {[...dietary, ...allergies, ...dislikes].length === 0 && (
                  <span className="text-ink-soft italic text-sm">None recorded.</span>
                )}
                {dietary.map((d) => (
                  <Chip key={`d-${d}`} variant="muted">{d}</Chip>
                ))}
                {allergies.map((a) => (
                  <Chip key={`a-${a}`} variant="warning">{a}</Chip>
                ))}
                {dislikes.map((x) => (
                  <Chip key={`x-${x}`} variant="muted">{x}</Chip>
                ))}
              </div>
            </DigestBlock>

            <DigestBlock title="Equipment">
              {equipment.length === 0 ? (
                <span className="text-ink-soft italic text-sm">None recorded.</span>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {equipment.slice(0, 24).map((slug) => (
                    <Chip key={slug} variant="default" className="font-mono text-xs">
                      {slug.replace(/_/g, " ")}
                    </Chip>
                  ))}
                </div>
              )}
            </DigestBlock>

            <DigestBlock title="Pantry top">
              {pantryTop.length === 0 ? (
                <span className="text-ink-soft italic text-sm">None recorded.</span>
              ) : (
                <ul className="text-sm flex flex-col gap-1.5">
                  {pantryTop.slice(0, 6).map((p, i) => (
                    <li key={i}>
                      <span className="text-ink-soft dark:text-cream/60 capitalize">
                        {p.category}:
                      </span>{" "}
                      <span className="text-ink dark:text-cream">{p.items.join(", ")}</span>
                    </li>
                  ))}
                </ul>
              )}
            </DigestBlock>
          </div>
        )}

        <div className="pt-3 border-t border-ink/5">
          <Link href="/onboarding" onClick={() => tapHaptic()}>
            <Button variant="outline" size="sm">Re-run onboarding</Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

function DigestBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs uppercase tracking-wide text-ink-soft dark:text-cream/60 font-semibold">
        {title}
      </div>
      <div>{children}</div>
    </div>
  );
}
