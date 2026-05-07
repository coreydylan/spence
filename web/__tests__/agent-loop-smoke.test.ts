/**
 * Smoke test for the chef agent web-side proxy.
 *
 * The actual agent loop runs on the worker now; this file verifies the
 * web-side wrapper:
 *   1. POSTs body { household_id, message, history } to <worker>/agent/chef
 *   2. Streams the SSE frames back as ChefEvents (text, ui_component, done)
 *   3. Surfaces transport errors as `error` + `done` events
 */

import { describe, it, expect } from "vitest";
import { chefAgent, type ChefEvent } from "../lib/chef-agent";

function sseStream(events: ChefEvent[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const e of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      }
      controller.close();
    },
  });
}

async function collect(gen: AsyncGenerator<ChefEvent>): Promise<ChefEvent[]> {
  const out: ChefEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("chefAgent (web proxy)", () => {
  it("forwards body to /agent/chef and yields SSE events", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      const events: ChefEvent[] = [
        {
          kind: "status",
          status: {
            household_id: "hh_test",
            onboarding: {
              current_tier: 1,
              tier_0_done: true,
              tier_1_done: true,
              completion_pct: 1,
              next_question: null,
              blocked_actions: [],
              engagement_signal: 0.8,
            },
            recommendation: { primary_action: "ready_to_plan", rationale: "" },
            signals: null,
          },
        },
        { kind: "thinking_start" },
        { kind: "text", delta: "Hey." },
        { kind: "done", reason: "stop" },
      ];
      return new Response(sseStream(events), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const events = await collect(
      chefAgent({
        message: "hi",
        household_id: "hh_test",
        history: [{ role: "user", content: "earlier" }],
        fetchImpl,
        workerUrl: "https://test.workers.dev",
      }),
    );

    expect(captured).toBeTruthy();
    expect(captured!.url).toBe("https://test.workers.dev/agent/chef");
    const body = JSON.parse(captured!.init.body as string);
    expect(body.household_id).toBe("hh_test");
    expect(body.message).toBe("hi");
    expect(body.history).toHaveLength(1);

    expect(events[0].kind).toBe("status");
    const text = events.find(e => e.kind === "text");
    expect(text).toBeTruthy();
    if (text && text.kind === "text") expect(text.delta).toBe("Hey.");
    expect(events[events.length - 1].kind).toBe("done");
  });

  it("surfaces onboarding ui_component event from worker", async () => {
    const fetchImpl = (async () => {
      const events: ChefEvent[] = [
        {
          kind: "status",
          status: {
            household_id: "hh_new",
            onboarding: {
              current_tier: 0,
              tier_0_done: false,
              tier_1_done: false,
              completion_pct: 0,
              next_question: { id: "q1", prompt: "first?" },
              blocked_actions: ["plan_compose_meal"],
              engagement_signal: 0,
            },
            recommendation: {
              primary_action: "answer_onboarding_question",
              rationale: "tier 0 incomplete",
              next_question: { id: "q1", prompt: "first?" },
            },
            signals: null,
          },
        },
        {
          kind: "ui_component",
          component: {
            component: "onboarding_question",
            props: { question: { id: "q1", prompt: "first?" } },
          },
        },
        { kind: "done", reason: "blocked_on_onboarding" },
      ];
      return new Response(sseStream(events), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const events = await collect(
      chefAgent({
        message: "plan dinners",
        household_id: "hh_new",
        fetchImpl,
        workerUrl: "https://test.workers.dev",
      }),
    );

    const ui = events.find(e => e.kind === "ui_component");
    expect(ui).toBeTruthy();
    if (ui && ui.kind === "ui_component") {
      expect(ui.component.component).toBe("onboarding_question");
    }
    const last = events[events.length - 1];
    if (last.kind === "done") expect(last.reason).toBe("blocked_on_onboarding");
  });

  it("surfaces non-OK worker response as error + done", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 502 })) as typeof fetch;
    const events = await collect(
      chefAgent({
        message: "hi",
        household_id: "hh_test",
        fetchImpl,
        workerUrl: "https://test.workers.dev",
      }),
    );
    const err = events.find(e => e.kind === "error");
    expect(err).toBeTruthy();
    if (err && err.kind === "error") expect(err.error).toContain("502");
    expect(events[events.length - 1].kind).toBe("done");
  });

  it("surfaces fetch failures as error + done", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const events = await collect(
      chefAgent({
        message: "hi",
        household_id: "hh_test",
        fetchImpl,
        workerUrl: "https://test.workers.dev",
      }),
    );
    const err = events.find(e => e.kind === "error");
    expect(err).toBeTruthy();
    if (err && err.kind === "error") expect(err.error).toBe("network down");
    expect(events[events.length - 1].kind).toBe("done");
  });
});
