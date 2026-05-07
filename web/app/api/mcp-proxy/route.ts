import { NextRequest } from "next/server";
import { getSessionFromRequest, UnauthorizedError } from "@/lib/auth";
import { mcp_call_any } from "@/lib/mcp";

export const runtime = "nodejs";

/**
 * POST /api/mcp-proxy
 *
 * Body: { tool: string, args?: Record<string, unknown> }
 *
 * Thin pass-through to the worker MCP. Attaches the household_id derived from
 * the session, so client code never has to know it. Use sparingly from client
 * components — most calls should go through the chef agent so they're traced.
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

  let body: { tool?: string; args?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (!body.tool) {
    return new Response(JSON.stringify({ error: "missing_tool" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  try {
    const result = await mcp_call_any(body.tool, body.args ?? {}, {
      household_id: session.household_id,
      caller_kind: "agent",
      caller_id: "spence-web-mcp-proxy",
    });
    return new Response(JSON.stringify({ result }), {
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: msg }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
}
