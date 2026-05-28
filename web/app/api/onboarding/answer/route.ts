// POST /api/onboarding/answer — record an onboarding answer when the user
// responds to an OnboardingQuestionCard rendered inline in the chat surface.
// Server-resolves household_id from CF Access (or DEV_USER_EMAIL fallback)
// and routes the answer to the worker's household_onboarding_answer MCP tool.

import { getSessionFromRequest, UnauthorizedError } from "@/lib/auth";
import { mcp } from "@/lib/mcp";

export const runtime = "edge";

export async function POST(req: Request): Promise<Response> {
  let session;
  try {
    session = await getSessionFromRequest(req);
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return new Response("unauthorized", { status: 401 });
    }
    throw e;
  }

  let body: { question_kind?: string; response_text?: string };
  try {
    body = (await req.json()) as { question_kind?: string; response_text?: string };
  } catch {
    return new Response("bad json", { status: 400 });
  }

  if (!body.question_kind) {
    return new Response("question_kind required", { status: 400 });
  }
  if (typeof body.response_text !== "string" || body.response_text.length === 0) {
    return new Response("response_text required", { status: 400 });
  }

  const result = await mcp(
    "household_onboarding_answer",
    {
      household_id: session.household_id,
      question_kind: body.question_kind,
      response_text: body.response_text,
    },
    { household_id: session.household_id },
  );

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
