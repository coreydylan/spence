import * as React from "react";
import { cn } from "@/lib/cn";

export interface EquipmentChipProps {
  slug: string;
  status?: "idle" | "claimed" | "unavailable";
  className?: string;
}

/**
 * EquipmentChip — small label for a piece of cooking equipment.
 *
 * Renders the slug as a humanized label ("stovetop_burner" → "stovetop
 * burner"). Status-tinted: idle (default), claimed (sage), unavailable
 * (amber outline). Non-interactive — Phase 5's brigade mode adds the
 * claim flow.
 */
export function EquipmentChip({ slug, status = "idle", className }: EquipmentChipProps) {
  const label = humanize(slug);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[var(--radius-full)] border px-3 py-1 text-sm font-medium",
        status === "idle" && "bg-cream-deep border-transparent text-ink-soft",
        status === "claimed" && "bg-sage/12 border-transparent text-sage",
        status === "unavailable" && "bg-transparent border-amber/40 text-amber",
        className,
      )}
      data-testid="equipment-chip"
    >
      {label}
    </span>
  );
}

function humanize(slug: string): string {
  return slug.replace(/_/g, " ").replace(/-/g, " ");
}
