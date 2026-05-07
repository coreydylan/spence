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
}: {
  message: Extract<Message, { role: "assistant" }>;
  showTyping?: boolean;
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
        return (
          <div key={`${t.id}-ui`} className="-mx-2 animate-fade-up">
            <Component {...props} />
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
  switch (event.kind) {
    case "text":
      return { ...message, text: message.text + event.delta };
    case "tool_call_start":
      return {
        ...message,
        tools: [
          ...message.tools,
          { id: event.call_id, name: event.tool_name, status: "running" },
        ],
      };
    case "tool_call_result":
      return {
        ...message,
        tools: message.tools.map((t) =>
          t.id === event.call_id
            ? { ...t, status: "done", ui: event.ui_component }
            : t,
        ),
      };
    case "tool_call_error":
      return {
        ...message,
        tools: message.tools.map((t) =>
          t.id === event.call_id ? { ...t, status: "error" } : t,
        ),
      };
    case "ui_component":
      return {
        ...message,
        tools: [
          ...message.tools,
          {
            id: uid("ui"),
            name: event.component.component,
            status: "done",
            ui: event.component,
          },
        ],
      };
    case "done":
      return { ...message, done: true };
    case "error":
      return { ...message, text: message.text + `\n\n_${event.error}_`, done: true };
    case "status":
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
