/**
 * Chef-of-staff agent — web-side proxy.
 *
 * The agent loop runs on the worker, not here. This file is a thin proxy
 * that forwards the user's message to the mise-graph worker's
 * `/agent/chef` route and streams its Server-Sent Events back to the
 * caller. The worker routes through the mesh-claude bridge (Corey's
 * Claude Code subscription) so we don't need an Anthropic API key in
 * the web app.
 *
 * Wire format unchanged from the old loop — the chat surface listens
 * for the same `ChefEvent` shapes (`text`, `tool_call_*`, `ui_component`,
 * `status`, `done`, `error`). Phase 1 only emits a subset
 * (`status`, `ui_component`, `thinking_start`, `text`, `error`, `done`);
 * tool-call events come back when Phase 2 wires worker-side tool routing.
 */

import type { ChefStatus, HouseholdSignals as _Signals } from "./mcp";

// ── Event types ────────────────────────────────────────────────────────────

export type ChefEvent =
  | { kind: "text"; delta: string }
  | { kind: "tool_call_start"; tool_name: string; call_id: string }
  | {
      kind: "tool_call_result";
      tool_name: string;
      call_id: string;
      result: unknown;
      ui_component?: UiComponent;
    }
  | {
      kind: "tool_call_error";
      tool_name: string;
      call_id: string;
      error: string;
    }
  | { kind: "ui_component"; component: UiComponent }
  | { kind: "status"; status: ChefStatus }
  | { kind: "thinking_start" }
  | { kind: "done"; reason?: string }
  | { kind: "error"; error: string };

export type UiComponent =
  | { component: "meal_card"; props: { meal: unknown } }
  | { component: "onboarding_question"; props: { question: unknown } }
  | { component: "weather_strip"; props: { summary: unknown } }
  | { component: "shop_summary"; props: { sections: unknown; runs?: unknown } }
  | { component: "pantry_summary"; props: { items: unknown } }
  | { component: "member_summary"; props: { members: unknown } }
  | { component: "trait_spread"; props: { spreads: unknown } }
  | { component: "brief_card"; props: { brief: unknown } };

// ── Worker proxy ───────────────────────────────────────────────────────────

const DEFAULT_WORKER_URL =
  "https://mise-graph.9f745064e644311ed09914b9a12e9c7380ce62b7.workers.dev";

function workerBase(): string {
  return (process.env.WORKER_URL ?? process.env.NEXT_PUBLIC_WORKER_URL ?? DEFAULT_WORKER_URL).replace(/\/$/, "");
}

export interface ChefAgentOptions {
  message: string;
  household_id: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /** Test injection — replaces the upstream fetch (worker call). */
  fetchImpl?: typeof fetch;
  /** Override worker base URL (tests / dev). */
  workerUrl?: string;
}

/**
 * Asynchronously yield ChefEvents from the worker's /agent/chef SSE stream.
 *
 * The shape mirrors the old in-process loop so the chat surface and tests
 * don't need to change. On any transport error we yield `error` + `done`
 * and finish.
 */
export async function* chefAgent(
  opts: ChefAgentOptions,
): AsyncGenerator<ChefEvent> {
  const url = `${opts.workerUrl ?? workerBase()}/agent/chef`;
  const fetchImpl = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        household_id: opts.household_id,
        message: opts.message,
        history: opts.history ?? [],
      }),
    });
  } catch (err) {
    yield { kind: "error", error: err instanceof Error ? err.message : String(err) };
    yield { kind: "done", reason: "fetch_failed" };
    return;
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    yield { kind: "error", error: `worker /agent/chef ${res.status}: ${txt.slice(0, 200)}` };
    yield { kind: "done", reason: "worker_error" };
    return;
  }

  if (!res.body) {
    yield { kind: "error", error: "worker returned empty body" };
    yield { kind: "done", reason: "empty_body" };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let boundary = buf.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buf.slice(0, boundary);
        buf = buf.slice(boundary + 2);
        boundary = buf.indexOf("\n\n");
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            yield JSON.parse(payload) as ChefEvent;
          } catch {
            // ignore malformed frames
          }
        }
      }
    }
  } catch (err) {
    yield { kind: "error", error: err instanceof Error ? err.message : String(err) };
    yield { kind: "done", reason: "stream_error" };
  }
}
