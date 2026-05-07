import { NextRequest } from "next/server";
import { getSessionFromRequest, UnauthorizedError } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * POST /api/shop/check
 *
 * Body: { shop_run_id: string, item_name: string, checked: boolean }
 *
 * MVP: localStorage on the client is the source of truth — this endpoint
 * accepts and acks but doesn't persist anywhere yet. When a D1 schema lands
 * for shop_check_state, wire it here. The route exists now so the client
 * already speaks the right protocol.
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

  let body: {
    shop_run_id?: string;
    item_name?: string;
    checked?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const { shop_run_id, item_name, checked } = body;
  if (!shop_run_id || !item_name || typeof checked !== "boolean") {
    return new Response(
      JSON.stringify({
        error: "missing_fields",
        required: ["shop_run_id", "item_name", "checked"],
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  // No-op for now — accepted, not persisted server-side.
  return new Response(
    JSON.stringify({
      ok: true,
      household_id: session.household_id,
      shop_run_id,
      item_name,
      checked,
      persisted: false,
      note: "client-side localStorage is source of truth for MVP",
    }),
    { headers: { "content-type": "application/json" } },
  );
}
