"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

export interface OtherMember {
  member_id: string;
  display_name?: string;
  presence: "in_kitchen_idle" | "busy_assigned" | "stepped_away" | "absent" | "unknown";
  current_task_title?: string | null;
}

export interface OtherMembersProps {
  members: OtherMember[];
  /** Hidden if `members` is empty (solo cook). */
  className?: string;
}

/**
 * OtherMembers — compact list of who else is in the brigade and what they're
 * on. Read-only from this member's perspective.
 *
 * Format per row:
 *   ● Katrina   on:  Press tofu
 *   ◌ Corey     idle
 *   ◐ Jamie     stepped away
 */
export function OtherMembers({ members, className }: OtherMembersProps) {
  if (members.length === 0) return null;
  return (
    <section
      aria-label="Other cooks"
      className={cn(
        "rounded-[var(--radius-lg)] bg-ink-surface px-5 py-4",
        className,
      )}
    >
      <p className="text-[11px] uppercase tracking-[0.18em] text-cream-faint mb-3 font-medium">
        Others
      </p>
      <ul className="space-y-2.5">
        {members.map((m) => (
          <li
            key={m.member_id}
            className="flex items-center gap-3 text-base text-cream-dim"
          >
            <PresenceDot presence={m.presence} />
            <span className="flex-1 truncate font-medium">
              {m.display_name ?? m.member_id}
            </span>
            <span className="text-cream-faint text-sm truncate max-w-[55%] text-right">
              {presenceLabel(m)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PresenceDot({ presence }: { presence: OtherMember["presence"] }) {
  const cls =
    presence === "busy_assigned"
      ? "bg-terracotta"
      : presence === "in_kitchen_idle"
      ? "bg-sage-soft"
      : presence === "stepped_away"
      ? "bg-amber"
      : "bg-cream-faint/40";
  return (
    <span
      className={cn("h-2 w-2 rounded-full shrink-0", cls)}
      aria-hidden
    />
  );
}

function presenceLabel(m: OtherMember): string {
  if (m.presence === "busy_assigned") {
    return m.current_task_title ? `on: ${m.current_task_title}` : "busy";
  }
  if (m.presence === "in_kitchen_idle") return "idle";
  if (m.presence === "stepped_away") return "stepped away";
  if (m.presence === "absent") return "not here";
  return "—";
}
