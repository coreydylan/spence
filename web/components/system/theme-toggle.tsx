"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

export type ThemePreference = "light" | "dark" | "system";

const COOKIE_NAME = "spence_theme";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1y

function readCookie(): ThemePreference {
  if (typeof document === "undefined") return "system";
  const m = document.cookie.match(new RegExp(`(?:^|; )${COOKIE_NAME}=([^;]+)`));
  if (!m) return "system";
  const v = decodeURIComponent(m[1]);
  return v === "light" || v === "dark" ? v : "system";
}

function writeCookie(value: ThemePreference): void {
  if (typeof document === "undefined") return;
  if (value === "system") {
    document.cookie = `${COOKIE_NAME}=; Max-Age=0; Path=/; SameSite=Lax`;
  } else {
    document.cookie = `${COOKIE_NAME}=${value}; Max-Age=${COOKIE_MAX_AGE}; Path=/; SameSite=Lax`;
  }
}

function applyTheme(pref: ThemePreference): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (pref === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", pref);
  }
}

/** Hook: returns the current preference + a setter that updates cookie + DOM. */
export function useTheme() {
  const [pref, setPref] = React.useState<ThemePreference>(() => readCookie());

  React.useEffect(() => {
    applyTheme(pref);
  }, [pref]);

  const update = React.useCallback((next: ThemePreference) => {
    writeCookie(next);
    applyTheme(next);
    setPref(next);
  }, []);

  return { pref, setPref: update };
}

/**
 * ThemeToggle — three-segment control: Light · System · Dark.
 *
 * Persists the choice to a cookie (`spence_theme`) so server renders can pick
 * it up too. Defaults to `system`, in which case CSS media queries handle
 * `prefers-color-scheme`.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { pref, setPref } = useTheme();

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className={cn(
        "inline-flex rounded-[var(--radius-full)] bg-cream-deep dark:bg-ink-soft/30 p-1 text-sm",
        className,
      )}
    >
      {(["light", "system", "dark"] as const).map((value) => {
        const active = pref === value;
        return (
          <button
            key={value}
            role="radio"
            aria-checked={active}
            onClick={() => setPref(value)}
            type="button"
            className={cn(
              "px-3 py-1 rounded-[var(--radius-full)] capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta",
              active
                ? "bg-white dark:bg-ink text-ink dark:text-cream shadow-[var(--shadow-soft)]"
                : "text-ink-soft dark:text-cream/70 hover:text-ink dark:hover:text-cream",
            )}
          >
            {value}
          </button>
        );
      })}
    </div>
  );
}

/**
 * ThemeBootstrap — render once at the top of `<html>` to pre-apply the
 * cookie-saved theme before paint. Avoids a flash of incorrect theme.
 */
export function ThemeBootstrapScript() {
  // Inline script, run before React hydrates.
  const code = `
(function () {
  try {
    var m = document.cookie.match(/(?:^|; )spence_theme=([^;]+)/);
    var v = m ? decodeURIComponent(m[1]) : null;
    if (v === 'light' || v === 'dark') {
      document.documentElement.setAttribute('data-theme', v);
    }
  } catch (e) {}
})();
`;
  return <script dangerouslySetInnerHTML={{ __html: code }} />;
}
