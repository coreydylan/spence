"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

export interface ExitCookProps {
  cook_session_id: string;
  onPause?: () => void;
  /** Called when user confirms exit. Must close the WS first. */
  onExit: () => Promise<void> | void;
}

/**
 * ExitCook — the bottom-of-screen cluster of "leave the kitchen" actions.
 *
 * - Pause cook: optional, fires `brigade_pause` via the parent (not done
 *   directly here so the parent can attach trace context).
 * - Exit kitchen: closes the WS and navigates back. Has a confirm step to
 *   prevent fat-finger exits.
 */
export function ExitCook({ cook_session_id, onPause, onExit }: ExitCookProps) {
  const router = useRouter();
  const [confirming, setConfirming] = React.useState(false);

  const handleExit = async () => {
    await onExit();
    router.push(`/recipe/${encodeURIComponent(cook_session_id)}`);
  };

  if (confirming) {
    return (
      <div
        role="alertdialog"
        aria-label="Confirm exit"
        className="rounded-[var(--radius-lg)] bg-ink-surface border border-amber/30 px-5 py-4"
      >
        <p className="text-base text-cream-dim mb-3">
          Leave the brigade? Your assignments will free up for someone else.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="h-12 rounded-[var(--radius-md)] border border-cream-faint/25 text-cream-dim text-base hover:bg-ink-surface-2"
          >
            Stay
          </button>
          <button
            type="button"
            onClick={handleExit}
            className="h-12 rounded-[var(--radius-md)] bg-amber text-ink-deep text-base font-medium hover:bg-amber/90"
          >
            Leave
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3">
      {onPause ? (
        <button
          type="button"
          onClick={onPause}
          className="h-12 rounded-[var(--radius-md)] border border-cream-faint/25 text-cream-dim text-base hover:bg-ink-surface-2"
        >
          Pause cook
        </button>
      ) : (
        <span />
      )}
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="h-12 rounded-[var(--radius-md)] border border-amber/30 text-amber-soft text-base hover:bg-amber/10"
      >
        Exit kitchen
      </button>
    </div>
  );
}
