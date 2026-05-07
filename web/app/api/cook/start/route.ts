import { NextRequest } from "next/server";
import { getSessionFromRequest, UnauthorizedError } from "@/lib/auth";
import { mcp_call_any } from "@/lib/mcp";

export const runtime = "nodejs";

/**
 * POST /api/cook/start
 *
 * Body: { meal_id: string; plan_id: string }
 *
 * Triggers the brigade hand-off:
 *   1. Generate a fresh `cook_session_id`.
 *   2. Call MCP `brigade_start({ cook_session_id, meal_id, plan_id, household_id })`
 *      which initializes the CookingLeadAgent Durable Object and arms its
 *      scheduler.
 *   3. Return `{ cook_session_id }` so the client can navigate to
 *      `/cook/[cook_session_id]` (Phase 5 owns that page).
 *
 * If the cooking-lead agent isn't bound (e.g. running against a worker
 * without `COOKING_LEAD_AGENT`), the brigade_start tool returns
 * `{ ok: false, error }` — we surface that as a 502 so the StartCookingButton
 * can show the user something useful.
 */
export async function POST(req: NextRequest) {
  let session;
  try {
    session = await getSessionFromRequest(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    throw err;
  }

  let body: { meal_id?: string; plan_id?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const meal_id = (body.meal_id ?? "").trim();
  const plan_id = (body.plan_id ?? "").trim();
  if (!meal_id || !plan_id) {
    return new Response(
      JSON.stringify({ error: "meal_id and plan_id required" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const cook_session_id = `cs_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 9)}`;

  try {
    const result = (await mcp_call_any(
      "brigade_start",
      {
        cook_session_id,
        meal_id,
        plan_id,
        household_id: session.household_id,
      },
      {
        household_id: session.household_id,
        caller_kind: "human",
        caller_id: "spence-web-cook-start",
      },
    )) as { ok?: boolean; error?: string };

    if (result?.ok === false) {
      return new Response(
        JSON.stringify({
          error: result.error ?? "brigade_start_failed",
          cook_session_id,
        }),
        { status: 502, headers: { "content-type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ cook_session_id, meal_id, plan_id }),
      { headers: { "content-type": "application/json" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: msg, cook_session_id }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
}
