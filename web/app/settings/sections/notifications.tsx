"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardSubtitle, CardTitle } from "@/components/primitives/card";
import { Badge } from "@/components/primitives/badge";
import { ThemeToggle } from "@/components/system/theme-toggle";
import { cn } from "@/lib/cn";
import { tapHaptic } from "@/lib/haptics";
import { useToast } from "@/components/system/toast-provider";

const COOKIE_PREFIX = "spence_notif_";

type Pref = "daily_brief" | "calendar_conflicts" | "equipment_conflicts" | "push";

const PREFS: Array<{ key: Pref; label: string; helper?: string; comingSoon?: boolean }> = [
  { key: "daily_brief", label: "Daily brief", helper: "A morning rundown of tonight's plan." },
  { key: "calendar_conflicts", label: "Calendar conflicts", helper: "When dinner runs into a meeting." },
  { key: "equipment_conflicts", label: "Equipment conflicts", helper: "When two recipes need the same pan." },
  { key: "push", label: "Push notifications", helper: "Phone-side push.", comingSoon: true },
];

function readPrefCookie(key: Pref): boolean {
  if (typeof document === "undefined") return key !== "push";
  const m = document.cookie.match(new RegExp(`(?:^|; )${COOKIE_PREFIX}${key}=([^;]+)`));
  if (!m) return key !== "push"; // sane defaults
  return m[1] === "1";
}

function writePrefCookie(key: Pref, value: boolean): void {
  if (typeof document === "undefined") return;
  const max = 60 * 60 * 24 * 365;
  document.cookie = `${COOKIE_PREFIX}${key}=${value ? "1" : "0"}; Max-Age=${max}; Path=/; SameSite=Lax`;
}

/**
 * NotificationsSection — toggles for the household's notification preferences.
 *
 * Preferences are persisted to a cookie for now (per-device); a real Phase-7
 * preferences table would replace this with an MCP tool. The push toggle is
 * gated as "coming soon".
 *
 * Also includes the dark-mode toggle here since it's the same "personal
 * device preference" surface.
 */
export function NotificationsSection() {
  const [vals, setVals] = React.useState<Record<Pref, boolean>>(() => ({
    daily_brief: false,
    calendar_conflicts: false,
    equipment_conflicts: false,
    push: false,
  }));
  const toast = useToast();

  // Hydrate from cookie on mount only (avoids SSR mismatch).
  React.useEffect(() => {
    setVals({
      daily_brief: readPrefCookie("daily_brief"),
      calendar_conflicts: readPrefCookie("calendar_conflicts"),
      equipment_conflicts: readPrefCookie("equipment_conflicts"),
      push: readPrefCookie("push"),
    });
  }, []);

  const toggle = (key: Pref, comingSoon?: boolean) => {
    if (comingSoon) {
      toast.info("Push notifications are coming soon");
      return;
    }
    tapHaptic();
    setVals((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      writePrefCookie(key, next[key]);
      return next;
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">Notifications</CardTitle>
        <CardSubtitle>How and when Spence reaches out.</CardSubtitle>
      </CardHeader>
      <CardContent className="flex flex-col">
        {PREFS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => toggle(p.key, p.comingSoon)}
            className={cn(
              "flex items-start justify-between gap-3 py-3 border-b border-ink/5 last:border-b-0 text-left",
              "hover:bg-cream-deep/40 dark:hover:bg-cream/5 -mx-1 px-1 rounded-[var(--radius-sm)] transition-colors",
            )}
          >
            <div className="flex-1 min-w-0">
              <div className="text-ink dark:text-cream font-medium leading-tight flex items-center gap-2">
                {p.label}
                {p.comingSoon && <Badge tone="amber">coming soon</Badge>}
              </div>
              {p.helper && (
                <div className="text-xs text-ink-soft dark:text-cream/60 mt-0.5 leading-snug">
                  {p.helper}
                </div>
              )}
            </div>
            <ToggleSwitch checked={vals[p.key]} disabled={p.comingSoon} />
          </button>
        ))}
        <div className="flex items-center justify-between pt-4 mt-2 border-t border-ink/5">
          <div>
            <div className="text-ink dark:text-cream font-medium">Theme</div>
            <div className="text-xs text-ink-soft dark:text-cream/60 mt-0.5">
              System matches your phone or laptop.
            </div>
          </div>
          <ThemeToggle />
        </div>
      </CardContent>
    </Card>
  );
}

function ToggleSwitch({ checked, disabled }: { checked: boolean; disabled?: boolean }) {
  return (
    <span
      role="switch"
      aria-checked={checked}
      className={cn(
        "shrink-0 inline-flex h-6 w-10 rounded-full transition-colors",
        checked ? "bg-sage" : "bg-ink/15 dark:bg-cream/15",
        disabled && "opacity-50",
      )}
    >
      <span
        className={cn(
          "h-5 w-5 rounded-full bg-white shadow-[var(--shadow-soft)] transition-transform mt-0.5",
          checked ? "translate-x-[1.125rem]" : "translate-x-0.5",
        )}
      />
    </span>
  );
}
