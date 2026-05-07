import * as React from "react";
import { cn } from "@/lib/cn";
import { getTier, type PerishTierId } from "@/lib/perishability";

interface Props {
  tier: PerishTierId;
  count: number;
  children: React.ReactNode;
}

/**
 * Section header for a perishability tier — colored accent bar on the left,
 * label + count, then the items below.
 */
export function PerishTierSection({ tier, count, children }: Props) {
  const meta = getTier(tier);
  const accentBg =
    meta.accent === "amber"
      ? "bg-amber"
      : meta.accent === "terracotta"
        ? "bg-terracotta"
        : "bg-sage";
  const labelColor =
    meta.accent === "amber"
      ? "text-amber"
      : meta.accent === "terracotta"
        ? "text-terracotta"
        : "text-sage";

  return (
    <section className="mt-8 first:mt-0">
      <header className="flex items-center gap-3 px-1 mb-2">
        <span aria-hidden className={cn("h-5 w-1 rounded-full", accentBg)} />
        <h3
          className={cn(
            "font-serif text-xl tracking-tight",
            labelColor,
          )}
        >
          {meta.label}
        </h3>
        <span className="text-ink-soft text-sm">({count})</span>
      </header>
      <ul className="bg-white/60 rounded-[var(--radius-md)] border border-ink/5 divide-y divide-ink/5">
        {children}
      </ul>
    </section>
  );
}
