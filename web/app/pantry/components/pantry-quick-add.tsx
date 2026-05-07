"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";

/**
 * Chip-style quick-add input. Submits via /api/pantry/add which wraps
 * household_set_pantry_bulk. Refreshes the page on success so the new item
 * shows up in its tier section.
 */
export function PantryQuickAdd() {
  const router = useRouter();
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/pantry/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: value }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `add failed (${res.status})`);
      }
      setText("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="px-1">
      <label className="sr-only" htmlFor="pantry-quick-add">
        Add an item
      </label>
      <div
        className={cn(
          "flex items-center gap-2 rounded-[var(--radius-full)] bg-white/80 border border-ink/10 px-4 py-2",
          "focus-within:ring-2 focus-within:ring-terracotta",
        )}
      >
        <span aria-hidden className="text-terracotta text-lg leading-none">+</span>
        <input
          id="pantry-quick-add"
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add an item"
          disabled={busy}
          className="flex-1 bg-transparent outline-none text-base placeholder:text-ink-soft/60"
          autoComplete="off"
        />
        {text.trim() && (
          <button
            type="submit"
            disabled={busy}
            className="text-sm font-medium text-terracotta disabled:opacity-50"
          >
            {busy ? "Adding…" : "Add"}
          </button>
        )}
      </div>
      {error && (
        <p className="mt-1.5 px-3 text-xs text-amber">{error}</p>
      )}
    </form>
  );
}
