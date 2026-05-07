"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

interface SheetProps {
  open: boolean;
  onClose: () => void;
  side?: "bottom" | "right";
  children: React.ReactNode;
  className?: string;
}

/**
 * Sheet — bottom-sliding drawer (mobile) or right-side drawer (tablet+).
 *
 * Minimal Phase 1 implementation: portal-less, click-outside-to-close, no
 * focus trap. Phase 2 agents should swap in Radix Dialog if a11y matters,
 * but for now this keeps the bundle tiny.
 */
export function Sheet({
  open,
  onClose,
  side = "bottom",
  children,
  className,
}: SheetProps) {
  React.useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/30 backdrop-blur-sm flex"
      onClick={onClose}
      aria-hidden="true"
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "bg-cream rounded-t-[var(--radius-lg)] shadow-[var(--shadow-card)] animate-fade-up",
          side === "bottom" && "mt-auto w-full max-h-[85dvh] overflow-y-auto",
          side === "right" &&
            "ml-auto h-full max-w-md w-full rounded-t-none rounded-l-[var(--radius-lg)]",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}
