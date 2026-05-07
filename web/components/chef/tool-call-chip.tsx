import * as React from "react";
import { cn } from "@/lib/cn";

interface ToolCallChipProps {
  toolName: string;
  status: "running" | "done" | "error";
  className?: string;
}

const TOOL_LABELS: Record<string, string> = {
  chef_status_check: "checking household status",
  inspire_read_household_signals: "reading your signals",
  inspire_read_weather: "looking up weather",
  plan_create: "creating plan",
  plan_compose_meal: "composing meal",
  plan_read_meal: "reading meal",
  household_onboarding_start: "starting onboarding",
  household_onboarding_answer: "saving answer",
  plan_audit: "auditing plan",
  plan_read_shopping_list: "reading shopping list",
};

function humanize(name: string): string {
  return TOOL_LABELS[name] ?? name.replace(/_/g, " ");
}

/**
 * ToolCallChip — small pill that appears inline in a chat bubble while a
 * tool call is in flight, then collapses to a "done" state once the result
 * arrives. Not interactive.
 *
 * Three states:
 *   running — terracotta dot + spinner, "looking up weather…"
 *   done    — sage check, "looked up weather"
 *   error   — amber warning, "weather lookup failed"
 */
export function ToolCallChip({ toolName, status, className }: ToolCallChipProps) {
  const label = humanize(toolName);
  const verb =
    status === "running"
      ? `${label}…`
      : status === "done"
        ? `${label.replace(/ing\b/, "ed")}`
        : `${label} failed`;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-[var(--radius-full)] px-2.5 py-1 text-xs font-mono",
        status === "running" && "bg-cream-deep text-ink-soft",
        status === "done" && "bg-sage/10 text-sage",
        status === "error" && "bg-amber/15 text-amber",
        className,
      )}
    >
      {status === "running" && <Spinner />}
      {status === "done" && <CheckDot />}
      {status === "error" && <ErrorDot />}
      {verb}
    </span>
  );
}

function Spinner() {
  return (
    <span className="h-2.5 w-2.5 rounded-full border-2 border-terracotta border-t-transparent animate-spin" />
  );
}
function CheckDot() {
  return <span className="h-2 w-2 rounded-full bg-sage" />;
}
function ErrorDot() {
  return <span className="h-2 w-2 rounded-full bg-amber" />;
}
