import * as React from "react";
import Link from "next/link";

/**
 * AddDayCta — terminal row on /plan inviting the user to extend the
 * planning window (e.g. "+ Add another day"). Routes to /chat with a
 * prepopulated prompt; the agent handles the actual extension.
 */
export function AddDayCta({ nextDate }: { nextDate?: string }) {
  const prompt = nextDate
    ? `Plan dinner for ${nextDate}`
    : "Add one more day to my plan";
  return (
    <Link
      href={`/chat?prompt=${encodeURIComponent(prompt)}`}
      className="block rounded-[var(--radius-md)] border border-dashed border-ink/15 px-4 py-5 text-center text-sm font-medium text-ink-soft hover:bg-cream-deep hover:text-terracotta transition-colors"
      data-testid="add-day-cta"
    >
      + Add another day
    </Link>
  );
}
