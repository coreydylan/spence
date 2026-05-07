"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

export interface EventLogEntry {
  id: string;
  /** Wall-clock time string, e.g. "17:23". */
  time: string;
  /** Short event description, e.g. "Corey ✓ Pressed tofu". */
  message: string;
  tone?: "default" | "ours" | "system" | "warn";
}

export interface EventLogProps {
  events: EventLogEntry[];
  /** Hard cap on rows (newest at top). Default 12. */
  limit?: number;
  className?: string;
}

/**
 * EventLog — scrolling list of recent brigade events.
 *
 * Renders newest-first. Each row is small but legible (14px). Lead messages,
 * help requests, and photo analyses get colored tone badges so the cook can
 * scan them at a glance.
 */
export function EventLog({ events, limit = 12, className }: EventLogProps) {
  const visible = events.slice(0, limit);
  return (
    <section
      aria-label="Brigade event log"
      className={cn(
        "rounded-[var(--radius-lg)] bg-ink-surface px-5 py-4",
        className,
      )}
    >
      <p className="text-[11px] uppercase tracking-[0.18em] text-cream-faint mb-3 font-medium">
        Events
      </p>
      {visible.length === 0 ? (
        <p className="text-sm text-cream-faint italic">
          Nothing yet. Events from the brigade will appear here.
        </p>
      ) : (
        <ul className="space-y-2">
          {visible.map((e) => (
            <li
              key={e.id}
              className="flex items-baseline gap-3 text-sm text-cream-dim animate-fade-up"
            >
              <span className="font-mono text-xs text-cream-faint w-12 shrink-0">
                {e.time}
              </span>
              <span
                className={cn(
                  "flex-1 leading-snug",
                  e.tone === "ours" && "text-terracotta-soft",
                  e.tone === "system" && "text-cream-faint italic",
                  e.tone === "warn" && "text-amber-soft",
                )}
              >
                {e.message}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
