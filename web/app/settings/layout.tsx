import * as React from "react";

/**
 * Settings layout — bounded width, vertical stack of section cards.
 *
 * Each section under `app/settings/sections/` is a Server Component that
 * fetches its own data (via MCP) and renders a `<Card>`. Edit modes use
 * the foundation `<Sheet>` primitive for the overlay.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8 flex flex-col gap-4">
      <header className="px-1 mb-2">
        <h1 className="font-serif text-4xl text-ink dark:text-cream tracking-tight">
          Settings
        </h1>
        <p className="text-ink-soft dark:text-cream/60 text-sm mt-1">
          What Spence knows about you, and how Spence reaches out.
        </p>
      </header>
      {children}
    </div>
  );
}
