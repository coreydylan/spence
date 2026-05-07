import * as React from "react";
import { cn } from "@/lib/cn";

interface PreferenceWarningProps {
  /** Headline — short, e.g. "Heads up — Friday's plan conflicts" */
  title?: string;
  /** Body — the human-readable grievance message. */
  message: string;
  /** Optional bullet points or extra context. */
  details?: string[];
  className?: string;
}

/**
 * PreferenceWarning — soft amber inline card.
 *
 * Used to surface non-blocking preference grievances on /today and /plan.
 * Visually quiet: a 2px left rule + amber tint, no shadow. Never use for
 * hard errors (those render as ink/rouge cards in the recipe page).
 */
export function PreferenceWarning({
  title = "Heads up",
  message,
  details,
  className,
}: PreferenceWarningProps) {
  return (
    <div
      role="status"
      className={cn(
        "rounded-[var(--radius-md)] bg-amber-soft/25 border-l-4 border-amber px-4 py-3 flex flex-col gap-1",
        className,
      )}
      data-testid="preference-warning"
    >
      <div className="text-xs font-semibold uppercase tracking-wide text-amber">
        {title}
      </div>
      <div className="text-sm text-ink leading-snug">{message}</div>
      {details && details.length > 0 && (
        <ul className="mt-1 text-xs text-ink-soft list-disc pl-5 flex flex-col gap-0.5">
          {details.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
