"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

export interface ShopRunTab {
  id: string;
  label: string;
  date: string;
  itemCount: number;
}

interface Props {
  runs: ShopRunTab[];
  activeId: string;
  onSelect: (id: string) => void;
}

/**
 * Pill-style tab strip — switches between shop runs (e.g. "Big shop" /
 * "Top-up"). Hidden when there's only one run.
 */
export function ShopRunTabs({ runs, activeId, onSelect }: Props) {
  if (runs.length <= 1) return null;
  return (
    <div
      role="tablist"
      aria-label="Shop runs"
      className="flex gap-2 px-1 overflow-x-auto scroll-soft pb-1"
    >
      {runs.map((run) => {
        const active = run.id === activeId;
        return (
          <button
            key={run.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(run.id)}
            className={cn(
              "shrink-0 px-4 py-2 rounded-[var(--radius-full)] text-sm font-medium transition-colors",
              active
                ? "bg-terracotta text-cream shadow-[var(--shadow-soft)]"
                : "bg-white/70 text-ink-soft hover:bg-white border border-ink/10",
            )}
          >
            <span className="block">{run.label}</span>
            <span className="block text-xs opacity-80 mt-0.5">
              {humanizeDate(run.date)} · {run.itemCount}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function humanizeDate(iso: string): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [y, m, d] = iso.split("-").map(Number);
  // Local-time interpretation; the date is plan-local already.
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
