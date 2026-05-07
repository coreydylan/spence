"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

interface NewMessagePillProps {
  visible: boolean;
  onClick: () => void;
  className?: string;
  label?: string;
}

/**
 * NewMessagePill — sticky "↓ new message" button shown when the user has
 * scrolled away from the bottom of the chat and a new message arrives.
 *
 * Tap to scroll to bottom + dismiss. Auto-dismisses (caller responsibility)
 * once the user reaches the bottom themselves.
 */
export function NewMessagePill({
  visible,
  onClick,
  className,
  label = "new message",
}: NewMessagePillProps) {
  if (!visible) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "absolute left-1/2 -translate-x-1/2 bottom-24 md:bottom-20 z-10",
        "inline-flex items-center gap-1.5 rounded-[var(--radius-full)] px-4 py-2 text-sm font-medium",
        "bg-ink text-cream shadow-[var(--shadow-card)] hover:bg-ink/90 transition-all",
        "animate-fade-up focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta focus-visible:ring-offset-2 focus-visible:ring-offset-cream",
        className,
      )}
      aria-label="Jump to newest message"
    >
      <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
        <path d="M10 14a1 1 0 0 1-.7-.3l-5-5a1 1 0 1 1 1.4-1.4L10 11.6l4.3-4.3a1 1 0 1 1 1.4 1.4l-5 5a1 1 0 0 1-.7.3z" />
      </svg>
      {label}
    </button>
  );
}
