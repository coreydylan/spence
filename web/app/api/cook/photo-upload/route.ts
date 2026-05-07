import { NextRequest } from "next/server";
import { getSessionFromRequest, UnauthorizedError } from "@/lib/auth";
import { mcp_call_any, WORKER_URL } from "@/lib/mcp";

export const runtime = "nodejs";

/**
 * POST /api/cook/photo-upload?cook_session_id=…&member_id=…&task_id=…
 *
 * Body: raw image bytes (the client should resize to ≤1024px first).
 * Content-Type: image/jpeg | image/webp | image/png.
 *
 * Server-side flow:
 *   1. Authenticate via CF Access (or DEV_USER_EMAIL).
 *   2. Grant a fresh single-use brigade token bound to the member.
 *   3. POST the raw image to the worker's `/upload-photo` route, attaching
 *      the token as a query param.
 *   4. Stream the worker's JSON response back to the client.
 *
 * Why server-side: the brigade token grant is admin-gated (the token IS the
 * auth at the worker). Granting from the browser would expose the admin
 * pathway. The cook page already has its own WS-bound token, but that one
 * is consumed by the WS upgrade — we mint a fresh token here.
 */
export async function POST(req: NextRequest) {
  let session;
  try {
    session = await getSessionFromRequest(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    throw err;
  }

  const url = new URL(req.url);
  const cook_session_id = url.searchParams.get("cook_session_id")?.trim() ?? "";
  const member_id = url.searchParams.get("member_id")?.trim() ?? "";
  const task_id = url.searchParams.get("task_id")?.trim() ?? "";

  if (!cook_session_id || !member_id) {
    return jsonResponse(
      { error: "cook_session_id and member_id required" },
      400,
    );
  }

  // 1. Mint a fresh token bound to (cook_session_id, member_id).
  let token: string;
  try {
    const grant = (await mcp_call_any(
      "brigade_grant_token",
      { cook_session_id, member_id },
      {
        household_id: session.household_id,
        caller_kind: "agent",
        caller_id: "spence-web-photo-upload",
      },
    )) as { token?: string };
    if (!grant?.token) {
      return jsonResponse({ error: "token_grant_failed" }, 502);
    }
    token = grant.token;
  } catch (err) {
    return jsonResponse(
      { error: err instanceof Error ? err.message : "token_grant_error" },
      502,
    );
  }

  // 2. Read the body (raw bytes). Next.js gives us a ReadableStream; we
  // collect into an ArrayBuffer for forwarding.
  const buf = await req.arrayBuffer();
  if (buf.byteLength === 0) {
    return jsonResponse({ error: "empty_body" }, 400);
  }

  // 3. Forward to worker. The worker route is NOT admin-gated — the token IS
  // the auth (consumed inside the DO).
  const target = new URL(
    `${WORKER_URL}/mise-graph/agents/cooking-lead/${encodeURIComponent(cook_session_id)}/upload-photo`,
  );
  target.searchParams.set("member_id", member_id);
  if (task_id) target.searchParams.set("task_id", task_id);
  target.searchParams.set("token", token);

  const contentType = req.headers.get("content-type") || "image/jpeg";

  try {
    const upstream = await fetch(target, {
      method: "POST",
      headers: { "content-type": contentType },
      body: buf,
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    return jsonResponse(
      { error: err instanceof Error ? err.message : "upload_failed" },
      502,
    );
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
