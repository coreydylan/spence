import { NextRequest } from "next/server";
import { getSessionFromRequest, UnauthorizedError } from "@/lib/auth";
import { chefAgent, type ChefEvent } from "@/lib/chef-agent";

export const runtime = "nodejs";

/**
 * POST /api/chef
 *
 * Body: { message: string, history?: [{role, content}] }
 *
 * Streams Server-Sent Events. Each event is a JSON-encoded ChefEvent on a
 * single `data:` line. The terminal event always has kind: "done".
 *
 * Client should:
 *   - read the body as a stream
 *   - split on \n\n
 *   - parse each `data: ...` payload as JSON
 *   - render each event into the chat surface
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

  let body: { message?: string; history?: Array<{ role: "user" | "assistant"; content: string }> };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const message = (body.message ?? "").trim();
  if (!message) {
    return new Response(JSON.stringify({ error: "empty_message" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();

      const send = (event: ChefEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        for await (const event of chefAgent({
          message,
          household_id: session.household_id,
          history: body.history,
        })) {
          send(event);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        send({ kind: "error", error: msg });
        send({ kind: "done", reason: "agent_error" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    },
  });
}
