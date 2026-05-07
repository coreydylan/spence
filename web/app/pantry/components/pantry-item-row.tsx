"use client";

import * as React from "react";
import { cn } from "@/lib/cn";
import { DidYouFinish } from "./did-you-finish";
import type { PerishTierId } from "@/lib/perishability";

interface Props {
  name: string;
  qty?: number | null;
  unit?: string | null;
  tier: PerishTierId;
  /** When true, the row shows the "Did you finish?" prompt. */
  expiringSoon?: boolean;
}

/**
 * Single pantry row. For Tier 1 items expiring within 48h the row also
 * inlines a "Did you finish?" prompt. The prompt is purely UI — wiring to
 * MCP (mark consumed) is left as a stub for the next agent.
 */
export function PantryItemRow({
  name,
  qty,
  unit,
  tier,
  expiringSoon,
}: Props) {
  const showFinish = expiringSoon === true && tier === 1;

  return (
    <li className="px-4 py-3">
      <div className="flex items-center gap-3">
        <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", dotClass(tier))} />
        <span className="flex-1 text-base text-ink truncate">{name}</span>
        {qty != null && (
          <span className="font-mono text-sm text-ink-soft tabular-nums">
            {formatQty(qty, unit ?? null)}
          </span>
        )}
      </div>
      {showFinish && <DidYouFinish itemName={name} />}
    </li>
  );
}

function dotClass(tier: PerishTierId): string {
  if (tier === 1) return "bg-amber";
  if (tier === 2) return "bg-terracotta";
  return "bg-sage";
}

function formatQty(qty: number, unit: string | null): string {
  const n = Math.abs(qty - Math.round(qty)) < 0.05 ? Math.round(qty) : Number(qty.toFixed(1));
  return unit ? `${n}${unit.length <= 2 ? "" : " "}${unit}` : `${n}`;
}
