import { NextRequest } from "next/server";
import { getSessionFromRequest, UnauthorizedError } from "@/lib/auth";
import { mcp } from "@/lib/mcp";

export const runtime = "nodejs";

/**
 * POST /api/pantry/add
 *
 * Body: { name: string, qty?: number, unit?: string }
 *
 * Wraps `household_set_pantry_bulk` with a single item, replace_existing=false.
 * The worker auto-categorizes the item and writes a row into
 * mise_kitchen_inventory plus a synthetic onboarding response so the trait
 * engine sees pantry-rich evidence accumulating.
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

  let body: { name?: string; qty?: number; unit?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const name = (body.name ?? "").trim();
  if (!name) {
    return new Response(JSON.stringify({ error: "missing_name" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  // Build a single-line item string. The worker parser handles "name 300g".
  const itemText =
    body.qty != null
      ? `${name} ${body.qty}${body.unit ?? ""}`.trim()
      : name;

  try {
    const result = await mcp(
      "household_set_pantry_bulk",
      {
        household_id: session.household_id,
        text: itemText,
        // worker default for replace_existing is false; keep it explicit:
        // (we pass via `items` if the worker prefers an array form — but
        // the typed args declare {text} which the worker parses)
      },
      {
        household_id: session.household_id,
        caller_kind: "human",
        caller_id: "spence-web-pantry-add",
      },
    );

    return new Response(
      JSON.stringify({
        ok: true,
        added: result.added,
        categorized: result.categorized,
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
