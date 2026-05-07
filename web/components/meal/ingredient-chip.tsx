import * as React from "react";
import { cn } from "@/lib/cn";

export interface IngredientChipProps {
  name: string;
  qty?: number | string | null;
  unit?: string | null;
  prep?: string | null;
  importance?: "core" | "swap" | "optional" | string | null;
  className?: string;
}

/**
 * IngredientChip — list-row style ingredient row with right-aligned qty.
 *
 * Used in the ingredient list on the recipe detail page. Designed for a
 * vertical list grouped by component role (starch / main / sauce / etc.).
 *
 * Visual: a thin row with a leading bullet, the canonical name, and a
 * monospace qty pinned right. Tapping is reserved for Phase 4's pantry/sub
 * flow — for now the chip is non-interactive.
 */
export function IngredientChip({
  name,
  qty,
  unit,
  prep,
  importance,
  className,
}: IngredientChipProps) {
  const qtyText = formatQty(qty, unit);
  const isOptional = importance === "optional" || importance === "swap";
  return (
    <li
      className={cn(
        "flex items-baseline gap-3 py-1.5 border-b border-ink/5 last:border-0",
        className,
      )}
      data-testid="ingredient-chip"
    >
      <span className="text-terracotta/60 leading-none">•</span>
      <span
        className={cn(
          "flex-1 text-base leading-snug",
          isOptional ? "text-ink-soft" : "text-ink",
        )}
      >
        {name}
        {prep && <span className="ml-1.5 text-ink-soft text-sm">({prep})</span>}
        {isOptional && (
          <span className="ml-2 text-xs uppercase tracking-wide text-ink-soft">
            {importance}
          </span>
        )}
      </span>
      {qtyText && (
        <span className="font-mono text-sm text-ink-soft tabular-nums">{qtyText}</span>
      )}
    </li>
  );
}

function formatQty(qty: number | string | null | undefined, unit: string | null | undefined): string {
  if (qty === null || qty === undefined || qty === "") return "";
  const num = typeof qty === "number" ? qty : Number(qty);
  if (Number.isFinite(num)) {
    const rounded = num >= 10 ? Math.round(num) : Math.round(num * 10) / 10;
    return unit ? `${rounded}${needsSpace(unit) ? " " : ""}${unit}` : `${rounded}`;
  }
  return unit ? `${qty} ${unit}` : `${qty}`;
}

function needsSpace(unit: string): boolean {
  // Tight unit symbols pair without space (e.g. "300g"); word units take a space ("4 clove").
  return /^[a-z]{3,}$/i.test(unit);
}
