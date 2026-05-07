"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

export type ToastTone = "info" | "success" | "warn" | "error";

export interface ToastShape {
  id: string;
  tone: ToastTone;
  title?: string;
  message: string;
  /** ms before auto-dismiss. 0 = sticky. Default 4000. */
  durationMs?: number;
}

interface ToastProps {
  toast: ToastShape;
  onDismiss: (id: string) => void;
}

const TONE_STYLES: Record<ToastTone, string> = {
  info: "bg-ink text-cream",
  success: "bg-sage text-cream",
  warn: "bg-amber text-cream",
  error: "bg-terracotta text-cream",
};

/**
 * Toast — a single slide-up notification, rendered by the ToastProvider.
 * Self-dismissing after `durationMs`. Rendered above the bottom tab bar.
 *
 * Use through the provider's `useToast()` hook — never instantiate directly.
 */
export function Toast({ toast, onDismiss }: ToastProps) {
  const { id, tone, title, message, durationMs = 4000 } = toast;

  React.useEffect(() => {
    if (durationMs <= 0) return;
    const t = window.setTimeout(() => onDismiss(id), durationMs);
    return () => window.clearTimeout(t);
  }, [id, durationMs, onDismiss]);

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "pointer-events-auto rounded-[var(--radius-md)] shadow-[var(--shadow-card)] px-4 py-3 max-w-sm animate-fade-up",
        TONE_STYLES[tone],
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          {title && <div className="font-medium leading-tight">{title}</div>}
          <div className={cn("text-sm leading-snug", title && "opacity-90 mt-0.5")}>{message}</div>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => onDismiss(id)}
          className="shrink-0 -mr-1 -mt-1 h-6 w-6 rounded-full inline-flex items-center justify-center hover:bg-cream/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cream/50"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
            <path d="M5.3 5.3a1 1 0 0 1 1.4 0L10 8.6l3.3-3.3a1 1 0 1 1 1.4 1.4L11.4 10l3.3 3.3a1 1 0 1 1-1.4 1.4L10 11.4l-3.3 3.3a1 1 0 1 1-1.4-1.4L8.6 10 5.3 6.7a1 1 0 0 1 0-1.4z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
