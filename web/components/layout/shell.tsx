import * as React from "react";
import Link from "next/link";
import { TabBar } from "./tab-bar";

/**
 * Shell — the app frame.
 *
 * - Top bar: just "Spence" wordmark (text-only, font-serif). Sticky on mobile.
 * - Children render in the middle, with bottom-padding for the tab bar.
 * - TabBar sits at the bottom on mobile only.
 *
 * Cook mode (`/cook/[id]`) and onboarding hide the shell — those routes
 * render their own full-screen layout in their own segment.
 */
export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh flex flex-col">
      <header className="sticky top-0 z-20 bg-cream/95 backdrop-blur border-b border-ink/5">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <Link
            href="/"
            className="font-serif text-2xl tracking-tight text-ink hover:text-terracotta transition-colors"
          >
            Spence
          </Link>
          <span className="text-xs text-ink-soft hidden sm:inline">chef-of-staff</span>
        </div>
      </header>

      <main className="flex-1 pb-20 md:pb-8">{children}</main>

      <TabBar />
    </div>
  );
}
