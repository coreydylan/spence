"use client";

import * as React from "react";
import { ChefBubble } from "@/components/chef/chef-bubble";
import { UserBubble } from "@/components/chef/user-bubble";
import { ChefInput } from "@/components/chef/chef-input";
import { ToolCallChip } from "@/components/chef/tool-call-chip";
import { TypingIndicator } from "@/components/chat/typing-indicator";
import { SuggestedPrompts } from "@/components/chat/suggested-prompts";
import { MessageGroup } from "@/components/chat/message-group";
import { MarkdownBubble } from "@/components/chat/markdown-bubble";
import { NewMessagePill } from "@/components/chat/new-message-pill";
import { VoiceInputStub } from "@/components/chat/voice-input-stub";
import { resolve } from "@/lib/tool-renderers";
import { tapHaptic } from "@/lib/haptics";
import type { ChefEvent, UiComponent } from "@/lib/chef-agent";

// ── In-memory message model ─────────────────────────────────────────────────

type ToolCall = {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  ui?: UiComponent;
};

type Message =
  | { id: string; role: "user"; text: string }
  | {
      id: string;
      role: "assistant";
      text: string;
      tools: ToolCall[];
      done: boolean;
    };

function uid(prefix = "m"): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

// ── Component ───────────────────────────────────────────────────────────────

export default function ChatPage() {
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [stickToBottom, setStickToBottom] = React.useState(true);
  const [hasUnseen, setHasUnseen] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  // ── Auto-scroll: stick to bottom unless user scrolled up. ─────────────────
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickToBottom) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      setHasUnseen(false);
    } else {
      // New content arrived but we're scrolled up — surface the pill.
      if (messages.length > 0) setHasUnseen(true);
    }
    // We intentionally watch messages so streaming text triggers this too.
  }, [messages, stickToBottom]);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      // 40px threshold so jitter / momentum doesn't toggle stickiness.
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      setStickToBottom(atBottom);
      if (atBottom) setHasUnseen(false);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setStickToBottom(true);
    setHasUnseen(false);
  };

  // ── Submit handler ─────────────────────────────────────────────────────────

  const handleSubmit = async (text: string) => {
    tapHaptic();
    const userMsg: Message = { id: uid("u"), role: "user", text };
    const assistantId = uid("a");
    const assistantMsg: Message = {
      id: assistantId,
      role: "assistant",
      text: "",
      tools: [],
      done: false,
    };
    setStickToBottom(true); // user just sent — pin to bottom
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setBusy(true);

    const history = messages
      .map((m) => ({
        role: m.role,
        content:
          m.role === "user"
            ? m.text
            : (m as Extract<Message, { role: "assistant" }>).text,
      }))
      .filter((h) => h.content.trim().length > 0);

    try {
      await streamChef({ message: text, history }, (event) => {
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? applyEvent(m as Message, event) : m)),
        );
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId && m.role === "assistant"
            ? { ...m, text: m.text + `\n\n_Couldn't reach the chef: ${msg}_`, done: true }
            : m,
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  // ── Onboarding answer handler ─────────────────────────────────────────────
  // Injected into <OnboardingQuestionCard onAnswer={...}/> when the chat
  // surface renders an inline onboarding question. POSTs to /api/onboarding/
  // answer which routes through the worker's household_onboarding_answer MCP
  // tool, then appends the user's answer + next question (if any) as a new
  // message pair so the conversation flows naturally.
  const handleOnboardingAnswer = React.useCallback(
    async ({ question_id, answer }: { question_id: string; answer: unknown }) => {
      tapHaptic();
      const answerText =
        typeof answer === "string" ? answer : JSON.stringify(answer);
      const userMsg: Message = { id: uid("u"), role: "user", text: answerText };
      // Optimistically render the user's answer as a bubble so the UI doesn't
      // freeze while the worker round-trips.
      setMessages((prev) => [...prev, userMsg]);
      setStickToBottom(true);

      try {
        const resp = await fetch("/api/onboarding/answer", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            question_kind: question_id,
            response_text: answerText,
          }),
        });
        if (!resp.ok) {
          const text = await resp.text();
          setMessages((prev) => [
            ...prev,
            {
              id: uid("a"),
              role: "assistant",
              text: `Hmm, couldn't record that — ${text}. Try again?`,
              tools: [],
              done: true,
            },
          ]);
          return;
        }
        const result = (await resp.json()) as {
          next_question?: unknown;
          tier_advanced?: boolean;
        };
        if (result.next_question && typeof result.next_question === "object") {
          const assistantMsg: Message = {
            id: uid("a"),
            role: "assistant",
            text: "",
            done: true,
            tools: [
              {
                id: uid("ui"),
                name: "onboarding_question",
                status: "done",
                ui: {
                  component: "onboarding_question",
                  props: { question: result.next_question },
                },
              },
            ],
          };
          setMessages((prev) => [...prev, assistantMsg]);
        } else {
          // No more questions queued — the next chat turn will pick up where
          // we are (tier advanced, ready_to_plan, etc.).
          const text = result.tier_advanced
            ? "Got it. Want me to plan some dinners?"
            : "Got it.";
          setMessages((prev) => [
            ...prev,
            {
              id: uid("a"),
              role: "assistant",
              text,
              tools: [],
              done: true,
            },
          ]);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setMessages((prev) => [
          ...prev,
          {
            id: uid("a"),
            role: "assistant",
            text: `Network hiccup — ${msg}`,
            tools: [],
            done: true,
          },
        ]);
      }
    },
    [],
  );

  // ── Group consecutive same-author messages for shared-avatar layout ───────
  const groupFlags = React.useMemo(() => buildGroupFlags(messages), [messages]);

  return (
    <div className="relative flex flex-col h-[calc(100dvh-3.5rem)] max-w-3xl mx-auto w-full">
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto scroll-soft px-4 pt-4 pb-2"
      >
        {messages.length === 0 ? (
          <SuggestedPrompts onPick={handleSubmit} />
        ) : (
          <div className="flex flex-col">
            {messages.map((m, i) => {
              const flags = groupFlags[i];
              if (m.role === "user") {
                return (
                  <MessageGroup
                    key={m.id}
                    role="user"
                    isFirstInGroup={flags.isFirst}
                    isLastInGroup={flags.isLast}
                  >
                    <UserBubble>{m.text}</UserBubble>
                  </MessageGroup>
                );
              }
              return (
                <MessageGroup
                  key={m.id}
                  role="assistant"
                  isFirstInGroup={flags.isFirst}
                  isLastInGroup={flags.isLast}
                >
                  <AssistantBubble
                    message={m}
                    showTyping={busy && i === messages.length - 1 && m.text === "" && m.tools.length === 0}
                    onOnboardingAnswer={handleOnboardingAnswer}
                  />
                </MessageGroup>
              );
            })}
          </div>
        )}
      </div>

      <NewMessagePill visible={hasUnseen && !stickToBottom} onClick={scrollToBottom} />

      {/* Mic-button strip — sits just above the foundation's ChefInput. The
          stub fires a "coming soon" toast for now; Phase-6 will wire real
          SpeechRecognition (see VoiceInputStub for the API contract). */}
      <div className="px-3 -mb-1 flex justify-end">
        <VoiceInputStub />
      </div>
      <ChefInput onSubmit={handleSubmit} disabled={busy} />
    </div>
  );
}

// ── Assistant bubble: handles streaming text + tools + UI components ───────

function AssistantBubble({
  message,
  showTyping,
  onOnboardingAnswer,
}: {
  message: Extract<Message, { role: "assistant" }>;
  showTyping?: boolean;
  onOnboardingAnswer?: (input: { question_id: string; answer: unknown }) => void;
}) {
  // Show typing indicator pre-first-token
  if (showTyping) {
    return (
      <ChefBubble>
        <TypingIndicator inline />
      </ChefBubble>
    );
  }

  const hasContent = message.text.length > 0 || message.tools.length > 0;
  if (!hasContent) return null;

  // Tools that haven't produced a UI component become little "✓ found" pills.
  // Tools with a UI render the component instead.
  const renderedToolUis = message.tools.filter((t) => t.ui && t.status === "done");
  const chipTools = message.tools.filter((t) => !t.ui || t.status !== "done");

  return (
    <ChefBubble>
      {chipTools.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chipTools.map((t) => (
            <ToolCallChip key={t.id} toolName={t.name} status={t.status} />
          ))}
        </div>
      )}
      {message.text && <MarkdownBubble text={message.text} />}
      {renderedToolUis.map((t) => {
        const r = t.ui ? resolve(t.ui) : null;
        if (!r) return null;
        const { Component, props } = r;
        // OnboardingQuestionCard needs an onAnswer wired or its Send button
        // is a silent no-op. Inject the chat-level handler here.
        const extraProps =
          t.ui?.component === "onboarding_question" && onOnboardingAnswer
            ? { onAnswer: onOnboardingAnswer }
            : {};
        return (
          <div key={`${t.id}-ui`} className="-mx-2 animate-fade-up">
            <Component {...props} {...extraProps} />
          </div>
        );
      })}
    </ChefBubble>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

interface GroupFlags {
  isFirst: boolean;
  isLast: boolean;
}

function buildGroupFlags(messages: Message[]): GroupFlags[] {
  return messages.map((m, i) => {
    const prev = messages[i - 1];
    const next = messages[i + 1];
    const isFirst = !prev || prev.role !== m.role;
    const isLast = !next || next.role !== m.role;
    return { isFirst, isLast };
  });
}

function applyEvent(message: Message, event: ChefEvent): Message {
  if (message.role !== "assistant") return message;
  // CRITICAL: every code path must return a Message. Returning undefined
  // here puts undefined into the messages array and the next render crashes
  // on m.id. Use a `kind` switch with a default that no-ops, not an
  // exhaustive switch — the worker keeps adding event kinds and we don't
  // want a dropped frame to nuke the whole chat.
  const k = (event as { kind?: string }).kind;
  switch (k) {
    case "text": {
      const delta = (event as { delta?: string }).delta ?? "";
      return { ...message, text: message.text + delta };
    }
    case "tool_call_start": {
      const e = event as { call_id: string; tool_name?: string; tool?: string };
      return {
        ...message,
        tools: [
          ...message.tools,
          { id: e.call_id, name: e.tool_name ?? e.tool ?? "tool", status: "running" },
        ],
      };
    }
    case "tool_call_result": {
      const e = event as { call_id: string; ui_component?: UiComponent };
      return {
        ...message,
        tools: message.tools.map((t) =>
          t.id === e.call_id
            ? { ...t, status: "done", ui: e.ui_component }
            : t,
        ),
      };
    }
    case "tool_call_error": {
      const e = event as { call_id: string };
      return {
        ...message,
        tools: message.tools.map((t) =>
          t.id === e.call_id ? { ...t, status: "error" } : t,
        ),
      };
    }
    case "ui_component": {
      const e = event as { component: UiComponent };
      return {
        ...message,
        tools: [
          ...message.tools,
          {
            id: uid("ui"),
            name: e.component.component,
            status: "done",
            ui: e.component,
          },
        ],
      };
    }
    case "done":
      return { ...message, done: true };
    case "error": {
      const e = event as { error?: string; message?: string };
      return {
        ...message,
        text: message.text + `\n\n_${e.error ?? e.message ?? "unknown error"}_`,
        done: true,
      };
    }
    // Phase 1 / 3 / future events that the chat surface doesn't render —
    // explicitly no-op so the function doesn't return undefined.
    case "status":
    case "thinking_start":
    case "iteration_start":
    case "code_execute_start":
    case "code_execute_end":
    case "intent":
    case "workflow_spawned":
    default:
      return message;
  }
}

// ── Streaming client ────────────────────────────────────────────────────────

async function streamChef(
  body: { message: string; history: Array<{ role: "user" | "assistant"; content: string }> },
  onEvent: (event: ChefEvent) => void,
) {
  const res = await fetch("/api/chef", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`/api/chef ${res.status}: ${txt}`);
  }
  if (!res.body) {
    throw new Error("no response body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");

      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          const event = JSON.parse(payload) as ChefEvent;
          onEvent(event);
        } catch {
          // ignore malformed frames
        }
      }
    }
  }
}
