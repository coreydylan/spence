/**
 * Chef-of-staff agent loop.
 *
 * Runs server-side. Streams a typed event log that the client renders as
 * text + tool-call chips + UI components.
 *
 * The loop:
 *   1. Call chef_status_check to see whether onboarding is blocking.
 *   2. If blocked → emit an `onboarding_question` UI component and finish.
 *   3. Otherwise, run an Anthropic streaming completion with a curated tool
 *      list. Each tool_use → execute via MCP → feed result back to Claude.
 *   4. Translate every Anthropic stream event into a ChefEvent for the UI.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  mcp,
  mcp_call_any,
  type ChefStatus,
  type HouseholdSignals,
  type McpContext,
} from "./mcp";

// ── Event types (the wire format) ──────────────────────────────────────────

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

// ── Tool catalog (curated for context size) ────────────────────────────────

/**
 * For Phase 1 we expose ~12 tools to keep the system prompt small. Phase 2+
 * agents can either lift this list or call listTools() dynamically and filter
 * by onboarding state.
 */
export const PHASE_1_TOOL_NAMES = [
  "chef_status_check",
  "inspire_read_household_signals",
  "plan_read_meal",
  "plan_compose_meal",
  "plan_create",
  "household_onboarding_start",
  "household_onboarding_answer",
] as const;

interface ClaudeTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Hand-rolled minimal tool schemas. We could fetch from /mcp/plan-world via
 * tools/list, but that adds a round-trip on every chat turn — caching is fine
 * for Phase 1, and the parallel agents adding new tools will also add their
 * schemas here when they need them.
 */
export const PHASE_1_TOOLS: ClaudeTool[] = [
  {
    name: "chef_status_check",
    description:
      "Read the household's onboarding state and personality signals. Always call this first if you haven't already this turn — it tells you if onboarding is incomplete (in which case ask the next question) and gives you the household's voice/avoidances/traditions to inform every other call.",
    input_schema: {
      type: "object",
      properties: { household_id: { type: "string" } },
      required: ["household_id"],
    },
  },
  {
    name: "inspire_read_household_signals",
    description:
      "Read just the HouseholdSignals bundle (personality summary, traditions, pantry top items, equipment, avoidances). Call when you need to ground a creative answer in the household's voice but don't need full status.",
    input_schema: {
      type: "object",
      properties: { household_id: { type: "string" } },
      required: ["household_id"],
    },
  },
  {
    name: "plan_read_meal",
    description:
      "Read one meal at a slot. Pass either {meal_id} or {plan_id, slot_date, slot_label}. Slot label is one of breakfast|lunch|snack|dinner. Use after composing to confirm what you proposed.",
    input_schema: {
      type: "object",
      properties: {
        meal_id: { type: "string" },
        plan_id: { type: "string" },
        slot_date: { type: "string", description: "YYYY-MM-DD" },
        slot_label: { type: "string", enum: ["breakfast", "lunch", "snack", "dinner"] },
      },
    },
  },
  {
    name: "plan_compose_meal",
    description:
      "Add or replace a meal at a plan slot. Required: household_id, slot_date, slot_label, and a meal object with at minimum {title, format, cuisine}. Format is one of donburi|grain_bowl|sandwich|salad|soup|pasta|pizza|tacos|stir_fry|braise|roast|grill|sheet_pan|wok|curry|stew. The compose tool auto-fills components based on the format. If you don't have a plan_id yet, call plan_create first.",
    input_schema: {
      type: "object",
      properties: {
        household_id: { type: "string" },
        plan_id: { type: "string" },
        slot_date: { type: "string", description: "YYYY-MM-DD" },
        slot_label: {
          type: "string",
          enum: ["breakfast", "lunch", "snack", "dinner"],
        },
        meal: {
          type: "object",
          properties: {
            title: { type: "string" },
            format: { type: "string" },
            cuisine: { type: "string" },
            serves: { type: "number" },
          },
          required: ["title"],
        },
      },
      required: ["household_id", "slot_date", "slot_label", "meal"],
    },
  },
  {
    name: "plan_create",
    description:
      "Create an empty plan for a date range. Pass {household_id, start_date, end_date} (both YYYY-MM-DD). Returns {plan: {id, ...}} — pass that id to subsequent compose calls.",
    input_schema: {
      type: "object",
      properties: {
        household_id: { type: "string" },
        start_date: { type: "string" },
        end_date: { type: "string" },
      },
      required: ["household_id"],
    },
  },
  {
    name: "household_onboarding_start",
    description:
      "Begin tier-0 onboarding. Idempotent — safe to call on existing households. Returns {state, next_question}.",
    input_schema: {
      type: "object",
      properties: { household_id: { type: "string" } },
      required: ["household_id"],
    },
  },
  {
    name: "household_onboarding_answer",
    description:
      "Record an answer to an onboarding question. Returns the next_question (or null if the session quota is hit) and whether the tier just advanced.",
    input_schema: {
      type: "object",
      properties: {
        household_id: { type: "string" },
        question_id: { type: "string" },
        answer: {},
      },
      required: ["household_id", "question_id", "answer"],
    },
  },
];

// ── System prompt builder ──────────────────────────────────────────────────

export function buildSystemPrompt(
  status: ChefStatus | null,
  signals: HouseholdSignals | null,
): string {
  const personality =
    signals?.personality?.summary ?? "Still calibrating; no personality signal yet.";

  const traditions =
    signals?.traditions && signals.traditions.length > 0
      ? signals.traditions
          .map((t) => `- ${t.name} (${t.cadence}): ${t.description ?? ""}`.trim())
          .join("\n")
      : "(none recorded yet)";

  const avoidances = signals?.avoidances
    ? [
        ...(signals.avoidances.dietary ?? []),
        ...(signals.avoidances.allergies ?? []),
        ...(signals.avoidances.dislikes ?? []),
      ].join(", ") || "(none)"
    : "(unknown — onboarding incomplete)";

  const equipment =
    signals?.equipment_available?.join(", ") || "(unknown)";

  const onboardingNote =
    status?.onboarding && !status.onboarding.tier_0_done
      ? "\n\nIMPORTANT: tier 0 onboarding is incomplete. If the user asks for plan-related actions, ask the next onboarding question first — do not call plan_compose_meal or plan_create yet."
      : "";

  return [
    "You are Spence, a chef-of-staff agent embedded in a household's life.",
    "You speak warmly, briefly, in second person — like a friend who happens to know what's in the fridge.",
    "You ground every recommendation in real tool calls; you never invent ingredients or recipes.",
    "Default to one or two short sentences. The user is at the stove or on their phone — be useful, not chatty.",
    "When you propose a meal, call plan_compose_meal so it lands on their plan.",
    "When you reference 'tonight' or 'this week' you must look it up via plan_read_meal — never guess.",
    "",
    `Household personality: ${personality}`,
    `Traditions: ${traditions === "(none recorded yet)" ? traditions : "\n" + traditions}`,
    `Avoidances: ${avoidances}`,
    `Equipment available: ${equipment}`,
    onboardingNote,
  ].join("\n");
}

// ── Agent loop ─────────────────────────────────────────────────────────────

export interface ChefAgentOptions {
  message: string;
  household_id: string;
  /** Caller-supplied to override defaults — useful in tests. */
  anthropic?: Pick<Anthropic, "messages">;
  mcpClient?: {
    call: <T>(tool: string, args: Record<string, unknown>) => Promise<T>;
  };
  model?: string;
  maxTurns?: number;
  /** Conversation history from the client (excluding the current user message). */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

const DEFAULT_MODEL = "claude-sonnet-4-5";

export async function* chefAgent(
  opts: ChefAgentOptions,
): AsyncGenerator<ChefEvent> {
  const ctx: McpContext = {
    household_id: opts.household_id,
    caller_kind: "agent",
    caller_id: "spence-web-chef",
  };

  const callTool = opts.mcpClient
    ? opts.mcpClient.call
    : <T,>(tool: string, args: Record<string, unknown>) =>
        mcp_call_any(tool, args, ctx) as Promise<T>;

  // 1. Status check FIRST.
  let status: ChefStatus | null = null;
  try {
    status = (await callTool<ChefStatus>("chef_status_check", {
      household_id: opts.household_id,
    })) as ChefStatus;
    yield { kind: "status", status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    yield { kind: "error", error: `chef_status_check failed: ${msg}` };
    yield { kind: "done", reason: "status_failed" };
    return;
  }

  // 2. If onboarding blocks, emit the question and stop.
  if (
    status.recommendation.primary_action === "answer_onboarding_question" &&
    status.onboarding.blocked_actions.length > 0
  ) {
    const q = status.recommendation.next_question ?? status.onboarding.next_question;
    if (q) {
      yield {
        kind: "ui_component",
        component: { component: "onboarding_question", props: { question: q } },
      };
      yield { kind: "done", reason: "blocked_on_onboarding" };
      return;
    }
  }

  // 3. Anthropic streaming with tool use.
  const anthropic =
    opts.anthropic ??
    (process.env.ANTHROPIC_API_KEY
      ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      : null);

  if (!anthropic) {
    // Fallback: emit a useful canned reply so the wiring still demos.
    yield {
      kind: "text",
      delta:
        "(ANTHROPIC_API_KEY isn't set, so I can't think out loud right now — but the wiring works! Add the key to .env.local and I'll come alive.)",
    };
    yield { kind: "done", reason: "no_api_key" };
    return;
  }

  const system = buildSystemPrompt(status, status.signals);
  const tools = PHASE_1_TOOLS;
  const model = opts.model ?? DEFAULT_MODEL;
  const maxTurns = opts.maxTurns ?? 6;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = [
    ...(opts.history ?? []).map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: opts.message },
  ];

  for (let turn = 0; turn < maxTurns; turn++) {
    let assistantBlocks: Array<
      | { type: "text"; text: string }
      | { type: "tool_use"; id: string; name: string; input: unknown }
    > = [];
    let stopReason: string | null = null;
    let textBuffer = "";
    const toolUses: { id: string; name: string; input: string }[] = [];

    const stream = anthropic.messages.stream({
      model,
      system,
      messages,
      tools,
      max_tokens: 2048,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const event of stream as any) {
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "tool_use") {
          toolUses.push({ id: block.id, name: block.name, input: "" });
          yield { kind: "tool_call_start", tool_name: block.name, call_id: block.id };
        }
      } else if (event.type === "content_block_delta") {
        const delta = event.delta;
        if (delta.type === "text_delta") {
          textBuffer += delta.text;
          yield { kind: "text", delta: delta.text };
        } else if (delta.type === "input_json_delta") {
          const last = toolUses[toolUses.length - 1];
          if (last) last.input += delta.partial_json ?? "";
        }
      } else if (event.type === "message_delta") {
        if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
      }
    }

    // Final message reconstruction.
    const finalMessage = await stream.finalMessage();
    assistantBlocks = finalMessage.content as typeof assistantBlocks;
    stopReason = finalMessage.stop_reason ?? stopReason;

    // Push the assistant turn into history.
    messages.push({ role: "assistant", content: assistantBlocks });

    // If no tool use, we're done.
    if (stopReason !== "tool_use") {
      yield { kind: "done", reason: stopReason ?? "stop" };
      return;
    }

    // Execute each tool_use block, feed results back.
    const toolResults: Array<{
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }> = [];

    for (const block of assistantBlocks) {
      if (block.type !== "tool_use") continue;
      const toolName = block.name;
      const args = (block.input ?? {}) as Record<string, unknown>;

      try {
        const result = await callTool<unknown>(toolName, args);
        const ui = pickUiComponent(toolName, result);
        yield {
          kind: "tool_call_result",
          tool_name: toolName,
          call_id: block.id,
          result,
          ui_component: ui,
        };
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(truncateForLLM(result)),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        yield {
          kind: "tool_call_error",
          tool_name: toolName,
          call_id: block.id,
          error: msg,
        };
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Error: ${msg}`,
          is_error: true,
        });
      }
    }

    messages.push({ role: "user", content: toolResults });
    // Loop continues — next iteration reads the tool results.
    // textBuffer already streamed; nothing else to do.
  }

  yield { kind: "done", reason: "max_turns" };
}

function pickUiComponent(toolName: string, result: unknown): UiComponent | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;

  if (toolName === "plan_read_meal" || toolName === "plan_compose_meal") {
    if ("meal" in r) {
      return { component: "meal_card", props: { meal: r.meal } };
    }
  }

  if (toolName === "plan_read_shopping_list" && "sections" in r) {
    return {
      component: "shop_summary",
      props: { sections: r.sections, runs: r.runs },
    };
  }

  if (toolName === "member_list" && "members" in r) {
    return { component: "member_summary", props: { members: r.members } };
  }

  if (toolName === "household_get_trait_spread" && "spreads" in r) {
    return { component: "trait_spread", props: { spreads: r.spreads } };
  }

  if (
    toolName === "household_read_brief" &&
    "ok" in r &&
    r.ok === true &&
    "brief" in r
  ) {
    return { component: "brief_card", props: { brief: r.brief } };
  }

  return undefined;
}

/** Hard-cap tool results to keep context windows sane. */
function truncateForLLM(result: unknown, max = 4000): unknown {
  const json = JSON.stringify(result);
  if (json.length <= max) return result;
  return {
    _truncated: true,
    preview: json.slice(0, max),
    note: `result was ${json.length} chars; truncated to ${max}`,
  };
}
