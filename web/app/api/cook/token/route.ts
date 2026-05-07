import { NextRequest } from "next/server";
import { getSessionFromRequest, UnauthorizedError } from "@/lib/auth";
import { mcp_call_any } from "@/lib/mcp";

export const runtime = "nodejs";

/**
 * POST /api/cook/token
 *
 * Body: { cook_session_id: string; member_id: string }
 *
 * Calls `brigade_grant_token` on the worker MCP and returns the resulting
 * `{ token, expires_at_ms, ws_url, cook_session_id, member_id }`. The token
 * is single-use and member-bound (10-min TTL); the client immediately opens
 * `ws_url` to upgrade.
 *
 * The cook screen calls this both at first connect and again whenever the
 * BrigadeWS reconnect logic needs a fresh token (the previous one was
 * consumed at WS upgrade).
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

  let body: { cook_session_id?: string; member_id?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const cook_session_id = (body.cook_session_id ?? "").trim();
  const member_id = (body.member_id ?? "").trim();
  if (!cook_session_id || !member_id) {
    return new Response(
      JSON.stringify({ error: "cook_session_id and member_id required" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  try {
    const result = (await mcp_call_any(
      "brigade_grant_token",
      { cook_session_id, member_id },
      {
        household_id: session.household_id,
        caller_kind: "agent",
        caller_id: "spence-web-cook-token",
      },
    )) as {
      token?: string;
      expires_at_ms?: number;
      ws_url?: string;
      cook_session_id?: string;
      member_id?: string;
    };

    if (!result?.token || !result?.ws_url) {
      return new Response(
        JSON.stringify({ error: "token_grant_failed", upstream: result }),
        { status: 502, headers: { "content-type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        token: result.token,
        expires_at_ms: result.expires_at_ms ?? null,
        ws_url: result.ws_url,
        cook_session_id: result.cook_session_id ?? cook_session_id,
        member_id: result.member_id ?? member_id,
      }),
      { headers: { "content-type": "application/json" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: msg }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
}
