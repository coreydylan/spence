"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/primitives/button";

interface Props {
  meal_id: string;
  plan_id: string;
}

/**
 * StartCookingButton — terracotta CTA on the recipe hero.
 *
 * Posts to `/api/cook/start` which transitions the MealAgent into
 * active_cook and returns a `cook_session_id`. The user is then
 * redirected to `/cook/[cook_session_id]` (Phase 5 owns that page; for
 * now the route renders a "Cook mode coming soon" placeholder).
 */
export function StartCookingButton({ meal_id, plan_id }: Props) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleClick = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/cook/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ meal_id, plan_id }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? `start failed (${res.status})`);
      }
      const j = (await res.json()) as { cook_session_id: string };
      router.push(`/cook/${j.cook_session_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="primary"
        size="lg"
        loading={busy}
        onClick={handleClick}
        className="w-full md:w-auto"
      >
        Start cooking →
      </Button>
      {error && <p className="text-xs text-amber">Couldn&rsquo;t start: {error}</p>}
    </div>
  );
}
