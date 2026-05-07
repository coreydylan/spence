"use client";

import * as React from "react";
import { cn } from "@/lib/cn";
import {
  loadChecked,
  saveChecked,
  normalizeItemKey,
  postCheck,
} from "@/lib/shop-state";

interface Props {
  shopRunId: string;
  name: string;
  qty: number | null;
  unit: string | null;
}

/**
 * Single shopping list item row with a checkbox.
 * State persists to localStorage keyed on `shop_${shop_run_id}_checked`.
 * Best-effort POST to /api/shop/check for server-side persistence.
 */
export function ShopItemRow({ shopRunId, name, qty, unit }: Props) {
  const key = normalizeItemKey(name);
  const [checked, setChecked] = React.useState(false);

  // Lazy-hydrate from localStorage on mount.
  React.useEffect(() => {
    const set = loadChecked(shopRunId);
    setChecked(set.has(key));
  }, [shopRunId, key]);

  const toggle = React.useCallback(() => {
    const set = loadChecked(shopRunId);
    const next = !checked;
    if (next) set.add(key);
    else set.delete(key);
    saveChecked(shopRunId, set);
    setChecked(next);
    void postCheck(shopRunId, name, next);
  }, [shopRunId, key, name, checked]);

  const qtyLabel = formatQty(qty, unit);

  return (
    <li>
      <button
        type="button"
        onClick={toggle}
        aria-pressed={checked}
        className={cn(
          "w-full flex items-center gap-3 px-3 py-2.5 text-left rounded-[var(--radius-sm)]",
          "hover:bg-cream-deep/60 transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "h-5 w-5 shrink-0 rounded-[6px] border flex items-center justify-center transition-all",
            checked
              ? "bg-sage border-sage text-cream"
              : "bg-white/80 border-ink/20",
          )}
        >
          {checked && (
            <svg viewBox="0 0 16 16" className="h-3 w-3" aria-hidden>
              <path
                d="M3 8.5L6.5 12L13 5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </span>
        <span
          className={cn(
            "flex-1 text-base",
            checked ? "text-ink-soft line-through decoration-1" : "text-ink",
          )}
        >
          {name}
        </span>
        {qtyLabel && (
          <span
            className={cn(
              "font-mono text-sm tabular-nums",
              checked ? "text-ink-soft/70" : "text-ink-soft",
            )}
          >
            {qtyLabel}
          </span>
        )}
      </button>
    </li>
  );
}

function formatQty(qty: number | null, unit: string | null): string {
  if (qty == null && !unit) return "";
  if (qty == null) return unit ?? "";
  const rounded =
    Math.abs(qty - Math.round(qty)) < 0.05 ? Math.round(qty) : Number(qty.toFixed(1));
  return unit ? `${rounded}${unit.length <= 2 ? "" : " "}${unit}` : `${rounded}`;
}
