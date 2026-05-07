"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardSubtitle, CardTitle } from "@/components/primitives/card";
import { Badge } from "@/components/primitives/badge";
import type { ChefStatus, HouseholdSignals } from "@/lib/mcp";

interface Observation {
  id?: string;
  kind?: string;
  observed_at?: string;
  summary?: string;
  confidence?: number;
}

interface DebugSectionProps {
  signals: HouseholdSignals | null;
  status: ChefStatus | null;
  observations: { observations: Observation[] } | unknown | null;
}

/**
 * DebugSection — collapsible by default. Shows trait values + confidences,
 * engagement signal, recent observations.
 *
 * Useful for power users + for proving Spence isn't bullshitting about what
 * it knows. Honest by construction.
 */
export function DebugSection({ signals, status, observations }: DebugSectionProps) {
  const [open, setOpen] = React.useState(false);

  const obsList: Observation[] = (observations as { observations: Observation[] } | null)?.observations ?? [];
  const dimensions = signals?.personality?.dimensions ?? [];

  return (
    <Card>
      <CardHeader>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center justify-between w-full text-left"
          aria-expanded={open}
        >
          <div>
            <CardTitle className="text-2xl">Debug</CardTitle>
            <CardSubtitle>What Spence&apos;s model says about you, in raw form.</CardSubtitle>
          </div>
          <span
            aria-hidden
            className="text-ink-soft text-xl transition-transform"
            style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
          >
            ›
          </span>
        </button>
      </CardHeader>
      {open && (
        <CardContent className="flex flex-col gap-5 font-mono text-xs">
          <DebugBlock title="Engagement signal">
            <span>
              {status?.onboarding?.engagement_signal != null
                ? status.onboarding.engagement_signal.toFixed(2)
                : "—"}
            </span>
          </DebugBlock>

          <DebugBlock title="Onboarding">
            <div className="flex flex-col gap-1">
              <Row label="tier_0_done" value={String(status?.onboarding?.tier_0_done ?? "—")} />
              <Row label="tier_1_done" value={String(status?.onboarding?.tier_1_done ?? "—")} />
              <Row label="completion_pct" value={`${status?.onboarding?.completion_pct ?? 0}%`} />
              <Row label="primary_action" value={status?.recommendation?.primary_action ?? "—"} />
            </div>
          </DebugBlock>

          <DebugBlock title="Personality dimensions">
            {dimensions.length === 0 ? (
              <span className="italic">No dimensions yet.</span>
            ) : (
              <div className="flex flex-col gap-1.5">
                {dimensions.map((d) => (
                  <div key={d.key} className="flex items-center justify-between gap-3">
                    <span className="text-ink-soft dark:text-cream/60 truncate">
                      {d.label ?? d.key}
                    </span>
                    <div className="flex items-center gap-2">
                      <span>{d.value.toFixed(2)}</span>
                      <Badge tone="neutral" className="!text-[10px]">
                        c={d.confidence.toFixed(2)}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </DebugBlock>

          <DebugBlock title="Recent observations">
            {obsList.length === 0 ? (
              <span className="italic">No observations recorded.</span>
            ) : (
              <ul className="flex flex-col gap-2">
                {obsList.slice(0, 12).map((o, i) => (
                  <li key={o.id ?? i} className="border-l-2 border-ink/10 pl-2">
                    <div className="flex items-center gap-2">
                      <Badge tone="neutral" className="!text-[10px]">
                        {o.kind ?? "obs"}
                      </Badge>
                      {o.observed_at && (
                        <span className="text-ink-soft dark:text-cream/60">{o.observed_at}</span>
                      )}
                    </div>
                    <div className="text-ink dark:text-cream/80 mt-0.5">{o.summary ?? "(no summary)"}</div>
                  </li>
                ))}
              </ul>
            )}
          </DebugBlock>
        </CardContent>
      )}
    </Card>
  );
}

function DebugBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-ink-soft dark:text-cream/60 uppercase tracking-wide text-[10px] font-sans font-semibold">
        {title}
      </div>
      <div className="bg-cream-deep/50 dark:bg-cream/5 rounded-[var(--radius-sm)] p-2.5">
        {children}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-ink-soft dark:text-cream/60">{label}</span>
      <span className="text-ink dark:text-cream/80">{value}</span>
    </div>
  );
}
