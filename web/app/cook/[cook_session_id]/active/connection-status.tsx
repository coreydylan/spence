"use client";

import * as React from "react";
import type { ConnectionStatus } from "@/lib/brigade-ws";
import { cn } from "@/lib/cn";

export interface ConnectionStatusProps {
  status: ConnectionStatus;
  /** Override the default copy (used in stories / tests). */
  detail?: string;
  className?: string;
}

/**
 * ConnectionStatus — small pill in the top-right of the cook UI.
 *
 * - `connected`: dim sage dot, "live"
 * - `connecting` / `reconnecting`: amber dot with spinner, "connecting" /
 *   "reconnecting…". The reconnecting state only shows after >2s of being
 *   disconnected (the parent throttles via a delayed timer).
 * - `disconnected` / `error`: amber dot + warning copy
 * - `closed`: muted, "session ended"
 */
export function ConnectionStatusBadge({
  status,
  detail,
  className,
}: ConnectionStatusProps) {
  const tone = toneFor(status);
  const label = labelFor(status, detail);
  const showSpin = status === "connecting" || status === "reconnecting";
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium",
        tone.bg,
        tone.text,
        className,
      )}
    >
      <span
        className={cn(
          "h-2 w-2 rounded-full",
          tone.dot,
          showSpin && "animate-pulse-dot",
        )}
        aria-hidden
      />
      {label}
    </div>
  );
}

type Tone = { bg: string; text: string; dot: string };

function toneFor(s: ConnectionStatus): Tone {
  switch (s) {
    case "connected":
      return {
        bg: "bg-sage/10",
        text: "text-sage-soft",
        dot: "bg-sage-soft",
      };
    case "connecting":
    case "reconnecting":
      return {
        bg: "bg-amber/12",
        text: "text-amber-soft",
        dot: "bg-amber-soft",
      };
    case "disconnected":
    case "error":
      return {
        bg: "bg-amber/15",
        text: "text-amber-soft",
        dot: "bg-amber",
      };
    case "closed":
    default:
      return {
        bg: "bg-ink-surface-2",
        text: "text-cream-faint",
        dot: "bg-cream-faint",
      };
  }
}

function labelFor(s: ConnectionStatus, detail?: string): string {
  switch (s) {
    case "connected":
      return "Live";
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return "Reconnecting…";
    case "disconnected":
      return detail ? `Disconnected (${detail})` : "Disconnected";
    case "error":
      return detail ? `Error (${detail})` : "Connection error";
    case "closed":
      return "Session ended";
    default:
      return s;
  }
}
