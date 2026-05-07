import * as React from "react";
import Link from "next/link";
import { headers } from "next/headers";
import { getSessionFromHeaders } from "@/lib/auth";
import { mcp_call_any } from "@/lib/mcp";
import type { BrigadeStateResult } from "@/lib/mcp";
import { ActiveCook } from "./active/active-cook";

interface PageProps {
  params: Promise<{ cook_session_id: string }>;
}

/**
 * /cook/[cook_session_id] — pre-cook join screen.
 *
 * Server-rendered. We:
 *   1. Read the brigade state via `brigade_get_state` (admin-bridged through
 *      the worker) so we can show the meal title, status, who's connected.
 *   2. Render a "Join brigade" CTA that, on click, mints a fresh token and
 *      transitions into the active cook UI (client component below).
 *
 * If the session isn't `active` (e.g. completed, abandoned, or doesn't
 * exist), we render a friendly fallback. The MealAgent owns the spawn
 * lifecycle — this page never tries to /init the brigade itself.
 */
export default async function CookSessionPage({ params }: PageProps) {
  const { cook_session_id } = await params;
  const hdrs = await headers();
  const session = await getSessionFromHeaders(hdrs);

  // Read state for the join screen. Best-effort — if the worker is unreachable
  // we still render the join form, the WS connect will surface any error.
  let state: BrigadeStateResult | null = null;
  let stateError: string | null = null;
  try {
    state = (await mcp_call_any(
      "brigade_get_state",
      { cook_session_id },
      {
        household_id: session.household_id,
        caller_kind: "agent",
        caller_id: "spence-web-cook-page",
      },
    )) as BrigadeStateResult;
  } catch (err) {
    stateError = err instanceof Error ? err.message : String(err);
  }

  const status = state?.state?.status ?? "unknown";
  const meal_id = state?.state?.meal_id ?? "";
  const expected_min = state?.state?.expected_duration_min ?? 0;

  // Member id derivation: for now we use the email-slug as the canonical
  // member id. Phase 6 will surface a member picker for shared phones.
  const member_id = `mem_${session.user_email
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")}`;

  if (status === "completed" || status === "abandoned") {
    return <CookEnded status={status} cook_session_id={cook_session_id} />;
  }

  if (stateError && !state) {
    return (
      <div className="px-5 py-10 max-w-xl mx-auto text-cream-dim">
        <p className="text-xs uppercase tracking-[0.2em] text-cream-faint mb-3">
          Cook session
        </p>
        <h1 className="font-serif text-3xl text-cream-dim mb-3">
          Couldn't reach the brigade
        </h1>
        <p className="text-base text-cream-dim/85 mb-6">
          {stateError}
        </p>
        <Link
          href="/today"
          className="inline-flex h-12 px-5 rounded-[var(--radius-md)] border border-cream-faint/25 text-cream-dim items-center"
        >
          Back to today
        </Link>
      </div>
    );
  }

  return (
    <ActiveCook
      cook_session_id={cook_session_id}
      member_id={member_id}
      meal_id={meal_id}
      expected_duration_min={expected_min}
      initial_brigade={state?.brigade ?? null}
    />
  );
}

function CookEnded({
  status,
  cook_session_id,
}: {
  status: string;
  cook_session_id: string;
}) {
  return (
    <div className="px-5 py-12 max-w-xl mx-auto text-cream-dim">
      <p className="text-xs uppercase tracking-[0.2em] text-cream-faint mb-3">
        Cook session · {cook_session_id}
      </p>
      <h1 className="font-serif text-3xl text-cream-dim mb-3">
        {status === "completed" ? "Cook complete" : "Cook ended"}
      </h1>
      <p className="text-base text-cream-dim/85 mb-6">
        {status === "completed"
          ? "Spence wrapped up this brigade. The recipe and notes are saved to your library."
          : "This session was abandoned. You can start a fresh cook from the meal page."}
      </p>
      <div className="flex gap-3">
        <Link
          href="/today"
          className="inline-flex h-12 px-5 rounded-[var(--radius-md)] bg-terracotta text-cream font-medium items-center"
        >
          Back to today
        </Link>
      </div>
    </div>
  );
}
