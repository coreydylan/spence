/**
 * Smoke test for the chef agent loop.
 *
 * Uses fake MCP + fake Anthropic stream to assert that:
 *   1. chef_status_check fires first
 *   2. blocked-on-onboarding short-circuits with a ui_component event
 *   3. unblocked path passes through tool_use → result → text
 */

import { describe, it, expect } from "vitest";
import { chefAgent, type ChefEvent } from "../lib/chef-agent";

// ── Fakes ──────────────────────────────────────────────────────────────────

interface AnthropicStreamScript {
  events: Array<unknown>;
  finalMessage: {
    content: Array<unknown>;
    stop_reason: string;
  };
}

function makeFakeAnthropic(scripts: AnthropicStreamScript[]) {
  let turn = 0;
  return {
    messages: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stream(_args: any) {
        const script = scripts[turn++];
        if (!script) throw new Error("fake anthropic ran out of scripts");
        async function* events() {
          for (const e of script.events) yield e;
        }
        return {
          [Symbol.asyncIterator]: () => events(),
          async finalMessage() {
            return script.finalMessage;
          },
        };
      },
    },
  };
}

function makeFakeMcp(handlers: Record<string, (args: unknown) => unknown>) {
  return {
    async call<T>(tool: string, args: Record<string, unknown>): Promise<T> {
      const h = handlers[tool];
      if (!h) throw new Error(`fake mcp: no handler for ${tool}`);
      return h(args) as T;
    },
  };
}

async function collect(gen: AsyncGenerator<ChefEvent>): Promise<ChefEvent[]> {
  const out: ChefEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("chefAgent", () => {
  it("emits status event from chef_status_check first", async () => {
    const mcp = makeFakeMcp({
      chef_status_check: () => ({
        household_id: "hh_test",
        onboarding: {
          current_tier: 1,
          tier_0_done: true,
          tier_1_done: true,
          completion_pct: 0.9,
          next_question: null,
          blocked_actions: [],
          engagement_signal: 0.8,
        },
        recommendation: {
          primary_action: "ready_to_plan",
          rationale: "all set",
        },
        signals: {
          household_id: "hh_test",
          generated_at_ms: Date.now(),
          personality: { summary: "warm and curious", dimensions: [] },
          traditions: [],
          pantry_top: [],
          equipment_available: ["oven", "stove"],
          avoidances: { dietary: [], allergies: [], dislikes: [] },
          member_spread_guidance: null,
        },
      }),
    });

    const anthropic = makeFakeAnthropic([
      {
        events: [
          {
            type: "content_block_start",
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Hey." },
          },
          { type: "message_delta", delta: { stop_reason: "end_turn" } },
        ],
        finalMessage: {
          content: [{ type: "text", text: "Hey." }],
          stop_reason: "end_turn",
        },
      },
    ]);

    const events = await collect(
      chefAgent({
        message: "hi",
        household_id: "hh_test",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        anthropic: anthropic as any,
        mcpClient: mcp,
      }),
    );

    expect(events[0].kind).toBe("status");
    const text = events.find((e) => e.kind === "text");
    expect(text).toBeTruthy();
    if (text && text.kind === "text") expect(text.delta).toBe("Hey.");
    expect(events[events.length - 1].kind).toBe("done");
  });

  it("short-circuits when onboarding blocks", async () => {
    const mcp = makeFakeMcp({
      chef_status_check: () => ({
        household_id: "hh_new",
        onboarding: {
          current_tier: 0,
          tier_0_done: false,
          tier_1_done: false,
          completion_pct: 0,
          next_question: { id: "q1", prompt: "What should I help with first?" },
          blocked_actions: ["plan_compose_meal", "plan_create"],
          engagement_signal: 0,
        },
        recommendation: {
          primary_action: "answer_onboarding_question",
          rationale: "tier 0 incomplete",
          next_question: { id: "q1", prompt: "What should I help with first?" },
        },
        signals: null,
      }),
    });

    const events = await collect(
      chefAgent({
        message: "plan me dinners this week",
        household_id: "hh_new",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        anthropic: { messages: { stream: () => { throw new Error("should not run"); } } } as any,
        mcpClient: mcp,
      }),
    );

    const ui = events.find((e) => e.kind === "ui_component");
    expect(ui).toBeTruthy();
    if (ui && ui.kind === "ui_component") {
      expect(ui.component.component).toBe("onboarding_question");
    }
    expect(events[events.length - 1].kind).toBe("done");
    if (events[events.length - 1].kind === "done") {
      const last = events[events.length - 1] as Extract<ChefEvent, { kind: "done" }>;
      expect(last.reason).toBe("blocked_on_onboarding");
    }
  });

  it("executes tool_use and feeds result back", async () => {
    let mealCalls = 0;
    const mcp = makeFakeMcp({
      chef_status_check: () => ({
        household_id: "hh_test",
        onboarding: {
          current_tier: 1,
          tier_0_done: true,
          tier_1_done: true,
          completion_pct: 1,
          next_question: null,
          blocked_actions: [],
          engagement_signal: 0.9,
        },
        recommendation: { primary_action: "ready_to_plan", rationale: "" },
        signals: null,
      }),
      plan_read_meal: () => {
        mealCalls++;
        return { meal: { id: "meal_1", title: "Tofu donburi", format: "donburi" } };
      },
    });

    const anthropic = makeFakeAnthropic([
      {
        events: [
          {
            type: "content_block_start",
            content_block: { type: "tool_use", id: "tool_1", name: "plan_read_meal", input: {} },
          },
          {
            type: "content_block_delta",
            delta: { type: "input_json_delta", partial_json: '{"meal_id":"meal_1"}' },
          },
          { type: "message_delta", delta: { stop_reason: "tool_use" } },
        ],
        finalMessage: {
          content: [
            { type: "tool_use", id: "tool_1", name: "plan_read_meal", input: { meal_id: "meal_1" } },
          ],
          stop_reason: "tool_use",
        },
      },
      {
        events: [
          {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Here it is." },
          },
          { type: "message_delta", delta: { stop_reason: "end_turn" } },
        ],
        finalMessage: {
          content: [{ type: "text", text: "Here it is." }],
          stop_reason: "end_turn",
        },
      },
    ]);

    const events = await collect(
      chefAgent({
        message: "what's tonight",
        household_id: "hh_test",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        anthropic: anthropic as any,
        mcpClient: mcp,
      }),
    );

    expect(mealCalls).toBe(1);

    const start = events.find((e) => e.kind === "tool_call_start");
    expect(start).toBeTruthy();
    if (start && start.kind === "tool_call_start") {
      expect(start.tool_name).toBe("plan_read_meal");
    }

    const result = events.find((e) => e.kind === "tool_call_result");
    expect(result).toBeTruthy();
    if (result && result.kind === "tool_call_result") {
      expect(result.ui_component?.component).toBe("meal_card");
    }

    expect(events[events.length - 1].kind).toBe("done");
  });
});
