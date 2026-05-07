"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

export type YourTaskState =
  | { kind: "idle" }
  | {
      kind: "active";
      task_id: string;
      title: string;
      detail?: string;
      est_min?: number;
      equipment?: string;
      acked: boolean;
    }
  | { kind: "awaiting"; task_id: string; title: string }
  | { kind: "done"; task_id: string; title: string };

export type TaskOutcome = "success" | "partial" | "retry" | "failure";

export interface YourTaskProps {
  state: YourTaskState;
  /** Hits send("ack_task", {task_id}). */
  onAck: (task_id: string) => void;
  /** Hits send("complete_task", {task_id, outcome}). */
  onComplete: (task_id: string, outcome: TaskOutcome) => void;
  /** Hits send("request_help", {task_id, reason}). */
  onRequestHelp: (task_id: string, reason: string) => void;
  /** Hits send("decline_task", {task_id, reason}). */
  onDecline: (task_id: string, reason: string) => void;
}

/**
 * YourTask — the headline "this is what you're doing right now" card.
 *
 * Reads the kitchen at arm's length: serif title 28px, detail 18px, three
 * thumb-sized buttons. Active state gets the terracotta glow border (see
 * `cook-active-glow` in globals.css).
 */
export function YourTask({
  state,
  onAck,
  onComplete,
  onRequestHelp,
  onDecline,
}: YourTaskProps) {
  if (state.kind === "idle") {
    return (
      <div className="rounded-[var(--radius-lg)] border border-cream-faint/15 bg-ink-surface px-6 py-8 text-center">
        <p className="font-serif text-2xl text-cream-dim mb-1">No task yet</p>
        <p className="text-base text-cream-faint">
          Spence is working out who should do what. You'll see your assignment
          here.
        </p>
      </div>
    );
  }

  if (state.kind === "awaiting") {
    return (
      <div
        data-testid="your-task-awaiting"
        className="rounded-[var(--radius-lg)] border border-cream-faint/15 bg-ink-surface px-6 py-6"
      >
        <p className="text-xs uppercase tracking-wide text-cream-faint mb-2">
          On it
        </p>
        <p className="font-serif text-2xl text-cream-dim">{state.title}</p>
      </div>
    );
  }

  if (state.kind === "done") {
    return (
      <div
        data-testid="your-task-done"
        className="rounded-[var(--radius-lg)] border border-sage/30 bg-sage/8 px-6 py-6"
      >
        <p className="text-xs uppercase tracking-wide text-sage-soft mb-2">
          Done
        </p>
        <p className="font-serif text-2xl text-cream-dim line-through decoration-sage-soft/50">
          {state.title}
        </p>
      </div>
    );
  }

  // active
  return (
    <section
      data-testid="your-task-active"
      aria-label="Your current task"
      className={cn(
        "rounded-[var(--radius-lg)] bg-ink-surface px-6 py-6 cook-active-glow",
      )}
    >
      <p className="text-[11px] uppercase tracking-[0.18em] text-terracotta mb-3 font-medium">
        Your task
      </p>
      <h2 className="font-serif text-3xl leading-tight text-cream-dim">
        {state.title}
      </h2>
      {state.detail && (
        <p className="mt-3 text-lg text-cream-dim/85">{state.detail}</p>
      )}
      <p className="mt-3 text-sm text-cream-faint">
        {state.est_min ? `est. ${state.est_min} min` : null}
        {state.est_min && state.equipment ? " · " : null}
        {state.equipment ?? null}
      </p>

      <div className="mt-6 grid grid-cols-3 gap-3">
        {!state.acked ? (
          <button
            type="button"
            className="col-span-3 h-14 rounded-[var(--radius-md)] bg-terracotta text-cream text-lg font-medium hover:bg-terracotta/90 active:bg-terracotta/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta-soft transition-colors"
            onClick={() => onAck(state.task_id)}
          >
            Got it
          </button>
        ) : (
          <button
            type="button"
            className="col-span-3 h-14 rounded-[var(--radius-md)] bg-sage text-cream text-lg font-medium hover:bg-sage/90 active:bg-sage/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage-soft transition-colors"
            onClick={() => onComplete(state.task_id, "success")}
          >
            Mark done
          </button>
        )}
        <button
          type="button"
          className="h-12 rounded-[var(--radius-md)] border border-cream-faint/20 text-cream-dim text-base hover:bg-ink-surface-2 active:bg-ink-surface-2"
          onClick={() => onRequestHelp(state.task_id, "needs_assist")}
        >
          Need help
        </button>
        <button
          type="button"
          className="h-12 rounded-[var(--radius-md)] border border-cream-faint/20 text-cream-dim text-base hover:bg-ink-surface-2 active:bg-ink-surface-2"
          onClick={() => onComplete(state.task_id, "partial")}
        >
          Partial
        </button>
        <button
          type="button"
          className="h-12 rounded-[var(--radius-md)] border border-amber/30 text-amber-soft text-base hover:bg-amber/10 active:bg-amber/15"
          onClick={() => onDecline(state.task_id, "skipped")}
        >
          Skip
        </button>
      </div>
    </section>
  );
}
