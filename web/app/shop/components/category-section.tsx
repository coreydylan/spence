"use client";

import * as React from "react";
import { ShopItemRow } from "./shop-item-row";

interface Item {
  name: string;
  quantity: number | null;
  unit: string | null;
}

interface Props {
  shopRunId: string;
  category: string;
  items: Item[];
  defaultOpen?: boolean;
}

/**
 * Collapsible category header + list of items. Open by default; tap to fold.
 * The header shows the count so the user can gauge progress at a glance.
 */
export function CategorySection({
  shopRunId,
  category,
  items,
  defaultOpen = true,
}: Props) {
  const [open, setOpen] = React.useState(defaultOpen);

  return (
    <section className="border-t border-ink/5 first:border-t-0 py-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-3 text-left rounded-[var(--radius-sm)] hover:bg-cream-deep/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta"
        aria-expanded={open}
      >
        <h3 className="font-serif text-xl text-ink tracking-tight">
          {humanize(category)}{" "}
          <span className="text-base text-ink-soft font-sans font-normal">
            ({items.length})
          </span>
        </h3>
        <span
          aria-hidden
          className={
            "h-5 w-5 text-ink-soft transition-transform " +
            (open ? "rotate-90" : "")
          }
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M6 4L10 8L6 12" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
      {open && (
        <ul className="px-1 pb-1">
          {items.map((it) => (
            <ShopItemRow
              key={`${shopRunId}:${it.name}`}
              shopRunId={shopRunId}
              name={it.name}
              qty={it.quantity}
              unit={it.unit}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function humanize(category: string): string {
  return category
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
