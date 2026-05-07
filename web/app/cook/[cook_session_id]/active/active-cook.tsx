"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  BrigadeWS,
  type ConnectionStatus,
  type IncomingMessage,
} from "@/lib/brigade-ws";
import { acquireWakeLock } from "@/lib/wake-lock";
import type { BrigadeSummary, BrigadeTokenGrant } from "@/lib/mcp";
import { ConnectionStatusBadge } from "./connection-status";
import { YourTask, type YourTaskState, type TaskOutcome } from "./your-task";
import { OtherMembers, type OtherMember } from "./other-members";
import { RecipeTimeline, type TimelineStep } from "./recipe-timeline";
import { EventLog, type EventLogEntry } from "./event-log";
import { PhotoCapture } from "./photo-capture";
import {
  IterationSuggestion,
  type IterationSuggestionData,
  type IterationAction,
} from "./iteration-suggestion";
import { ExitCook } from "./exit-cook";

export interface ActiveCookProps {
  cook_session_id: string;
  member_id: string;
  meal_id: string;
  expected_duration_min: number;
  /** Optional brigade summary from the server-side initial fetch. */
  initial_brigade: BrigadeSummary | null;
}

/**
 * ActiveCook — the live, WS-connected cook surface.
 *
 * Lifecycle:
 *   1. Mount: POST /api/cook/token → BrigadeTokenGrant (`token` + `ws_url`)
 *   2. Open BrigadeWS pointed at `ws_url`. Acquire wake lock.
 *   3. Stream messages → reduce into local state (YourTask, others, timeline,
 *      events). Render. Buttons fire `send(...)` back over the same socket.
 *   4. Reconnect: BrigadeWS auto-retries with backoff. The reconnect callback
 *      mints a fresh single-use token (the previous one was consumed) before
 *      each attempt.
 *   5. Unmount or user "exit": close WS, release wake lock.
 */
export function ActiveCook({
  cook_session_id,
  member_id,
  meal_id,
  expected_duration_min,
  initial_brigade,
}: ActiveCookProps) {
  const router = useRouter();

  // ── Connection state ─────────────────────────────────────────────────
  const [status, setStatus] = React.useState<ConnectionStatus>("connecting");
  const [statusDetail, setStatusDetail] = React.useState<string | undefined>();
  const [showReconnecting, setShowReconnecting] = React.useState(false);
  const reconnectTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // ── Domain state (reduced from incoming WS messages + initial fetch) ────
  const [task, setTask] = React.useState<YourTaskState>({ kind: "idle" });
  const [others, setOthers] = React.useState<OtherMember[]>(() =>
    initialOthers(initial_brigade, member_id),
  );
  const [steps, setSteps] = React.useState<TimelineStep[]>([]);
  const [events, setEvents] = React.useState<EventLogEntry[]>([]);
  const [iteration, setIteration] = React.useState<
    | (IterationSuggestionData & { suggestion_id: string })
    | null
  >(null);
  const [elapsedMs, setElapsedMs] = React.useState(0);
  const startedAtRef = React.useRef<number>(Date.now());

  // ── Refs (the WS, the wake-lock release fn) ─────────────────────────
  const wsRef = React.useRef<BrigadeWS | null>(null);
  const releaseWakeLockRef = React.useRef<(() => void) | null>(null);

  // Keep the WS state machine in a ref so handlers don't churn.
  const sendRef = React.useRef<((kind: string, data?: object) => boolean) | null>(
    null,
  );

  // ── Mount: token + WS + wake lock ──────────────────────────────────────
  React.useEffect(() => {
    let cancelled = false;
    let ws: BrigadeWS | null = null;

    async function start() {
      const grant = await fetchToken(cook_session_id, member_id).catch(() => null);
      if (!grant || cancelled) {
        setStatus("error");
        setStatusDetail("token_grant_failed");
        return;
      }

      ws = new BrigadeWS({
        ws_url: grant.ws_url,
        cook_session_id,
        member_id,
        onMessage: handleMessage,
        onStatus: (s, detail) => {
          setStatus(s);
          setStatusDetail(detail);
          // Throttled "reconnecting…" badge: only show after >2s in non-live.
          if (s === "connected" || s === "closed") {
            setShowReconnecting(false);
            if (reconnectTimerRef.current) {
              clearTimeout(reconnectTimerRef.current);
              reconnectTimerRef.current = null;
            }
          } else if (s === "reconnecting" || s === "disconnected") {
            if (!reconnectTimerRef.current) {
              reconnectTimerRef.current = setTimeout(() => {
                setShowReconnecting(true);
              }, 2_000);
            }
          }
        },
        onReconnect: async () => {
          const fresh = await fetchToken(cook_session_id, member_id).catch(
            () => null,
          );
          return fresh?.ws_url ?? null;
        },
      });
      wsRef.current = ws;
      sendRef.current = (kind, data) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (ws as BrigadeWS).send(kind as any, data as Record<string, unknown>);
      ws.open();

      acquireWakeLock()
        .then((release) => {
          if (cancelled) {
            release();
            return;
          }
          releaseWakeLockRef.current = release;
        })
        .catch(() => {
          /* not supported */
        });
    }

    void start();

    return () => {
      cancelled = true;
      ws?.close(1000, "unmount");
      wsRef.current = null;
      sendRef.current = null;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      const release = releaseWakeLockRef.current;
      releaseWakeLockRef.current = null;
      release?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cook_session_id, member_id]);

  // ── Elapsed timer ──────────────────────────────────────────────────────
  React.useEffect(() => {
    const id = setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // ── Heartbeat ping every 25s so dead sockets surface quickly ─────────
  React.useEffect(() => {
    const id = setInterval(() => {
      const ws = wsRef.current;
      if (ws && ws.getStatus() === "connected") ws.ping();
    }, 25_000);
    return () => clearInterval(id);
  }, []);

  // ── Message reducer ────────────────────────────────────────────────────
  const handleMessage = React.useCallback(
    (msg: IncomingMessage) => {
      const t = formatTime(msg.emitted_at_ms ?? Date.now());

      switch (msg.kind) {
        case "welcome": {
          appendEvent({
            id: `welcome-${msg.emitted_at_ms ?? Date.now()}`,
            time: t,
            message: "Joined the brigade",
            tone: "system",
          });
          return;
        }
        case "task_assigned": {
          const target = (msg.member_id ?? "").trim();
          const data = msg.data ?? {};
          const task_id = String(data.task_id ?? "");
          const title = String(data.title ?? data.task_id ?? "New task");
          const detail =
            typeof data.detail === "string"
              ? data.detail
              : typeof data.reason === "string"
              ? data.reason
              : undefined;
          const est_min =
            typeof data.est_min === "number"
              ? data.est_min
              : typeof data.active_min === "number"
              ? data.active_min
              : undefined;
          const equipment =
            typeof data.equipment === "string"
              ? data.equipment
              : Array.isArray(data.equipment)
              ? (data.equipment as string[]).join(", ")
              : undefined;

          if (target === member_id) {
            setTask({
              kind: "active",
              task_id,
              title,
              detail,
              est_min,
              equipment,
              acked: false,
            });
            appendEvent({
              id: `assigned-${task_id}-${msg.emitted_at_ms}`,
              time: t,
              message: `You: ${title}`,
              tone: "ours",
            });
          } else if (target) {
            updateOtherTask(setOthers, target, title);
            appendEvent({
              id: `assigned-${target}-${task_id}-${msg.emitted_at_ms}`,
              time: t,
              message: `${target}: ${title}`,
            });
          }
          // Mark step active in the timeline.
          setSteps((prev) =>
            prev.map((s) =>
              s.task_id === task_id
                ? { ...s, status: "active", member_display_name: target }
                : s,
            ),
          );
          return;
        }
        case "task_unassigned": {
          const data = msg.data ?? {};
          const task_id = String(data.task_id ?? "");
          if (msg.member_id === member_id) {
            setTask({ kind: "idle" });
          }
          setSteps((prev) =>
            prev.map((s) =>
              s.task_id === task_id ? { ...s, status: "pending" } : s,
            ),
          );
          appendEvent({
            id: `unassigned-${task_id}-${msg.emitted_at_ms}`,
            time: t,
            message: `Unassigned: ${task_id}`,
          });
          return;
        }
        case "task_completed": {
          const data = msg.data ?? {};
          const task_id = String(data.task_id ?? "");
          const who = msg.member_id;
          if (who === member_id) {
            setTask((prev) =>
              prev.kind === "active" && prev.task_id === task_id
                ? { kind: "done", task_id, title: prev.title }
                : prev,
            );
          } else if (who) {
            updateOtherTask(setOthers, who, null);
          }
          setSteps((prev) =>
            prev.map((s) =>
              s.task_id === task_id ? { ...s, status: "completed" } : s,
            ),
          );
          appendEvent({
            id: `completed-${task_id}-${msg.emitted_at_ms}`,
            time: t,
            message: `${who === member_id ? "You" : who} ✓ ${task_id}`,
            tone: who === member_id ? "ours" : "default",
          });
          return;
        }
        case "task_started": {
          const data = msg.data ?? {};
          const task_id = String(data.task_id ?? "");
          const who = msg.member_id;
          if (who === member_id) {
            setTask((prev) =>
              prev.kind === "active" && prev.task_id === task_id
                ? { ...prev, acked: true }
                : prev,
            );
          }
          setSteps((prev) =>
            prev.map((s) =>
              s.task_id === task_id ? { ...s, status: "active" } : s,
            ),
          );
          return;
        }
        case "task_help_requested": {
          const data = msg.data ?? {};
          const reason = String(data.reason ?? "needs assist");
          appendEvent({
            id: `help-${msg.emitted_at_ms}`,
            time: t,
            message: `${msg.member_id} needs help: ${reason}`,
            tone: "warn",
          });
          return;
        }
        case "phase_progress": {
          // Best-effort — surface as a system event.
          const data = msg.data ?? {};
          if (data && typeof data === "object" && "lead_message" in data) {
            return; // skip; the same content arrives as lead_message too
          }
          appendEvent({
            id: `phase-${msg.emitted_at_ms}`,
            time: t,
            message: humanPhase(data),
            tone: "system",
          });
          return;
        }
        case "lead_message": {
          const data = msg.data ?? {};
          const message =
            typeof data.message === "string"
              ? data.message
              : data.kind === "help_request"
              ? `${data.from_member_id ?? "someone"} asks for a hand`
              : "Spence: …";
          appendEvent({
            id: `lead-${msg.emitted_at_ms}`,
            time: t,
            message,
            tone: data.kind === "help_request" ? "warn" : "system",
          });
          return;
        }
        case "recipe_iteration_suggested": {
          const data = (msg.data ?? {}) as Record<string, unknown>;
          const action = (data.action as IterationAction) ?? "wait";
          const suggestion_id = `it-${msg.emitted_at_ms ?? Date.now()}`;
          setIteration({
            suggestion_id,
            task_id:
              typeof data.task_id === "string" ? data.task_id : null,
            action,
            detail:
              typeof data.detail === "string"
                ? data.detail
                : typeof data.message === "string"
                ? data.message
                : "Spence noticed something",
            ingredient_to_add:
              typeof data.ingredient_to_add === "string"
                ? data.ingredient_to_add
                : null,
            temp_delta_pct:
              typeof data.temp_delta_pct === "number"
                ? data.temp_delta_pct
                : null,
            extra_min:
              typeof data.extra_min === "number" ? data.extra_min : null,
          });
          appendEvent({
            id: suggestion_id,
            time: t,
            message: `Spence: ${
              typeof data.detail === "string" ? data.detail : "vision check"
            }`,
            tone: "system",
          });
          return;
        }
        case "session_ended": {
          appendEvent({
            id: `ended-${msg.emitted_at_ms}`,
            time: t,
            message: "Cook session ended",
            tone: "system",
          });
          // Don't auto-navigate — let the user read the events. The connection
          // status will flip to closed and the page will offer Back.
          return;
        }
        case "member_joined": {
          const who = msg.member_id;
          if (who && who !== member_id) {
            setOthers((prev) => upsertOther(prev, who));
            appendEvent({
              id: `joined-${who}-${msg.emitted_at_ms}`,
              time: t,
              message: `${who} joined`,
              tone: "system",
            });
          }
          return;
        }
        case "member_left": {
          const who = msg.member_id;
          if (who && who !== member_id) {
            setOthers((prev) =>
              prev.map((m) =>
                m.member_id === who ? { ...m, presence: "absent" } : m,
              ),
            );
            appendEvent({
              id: `left-${who}-${msg.emitted_at_ms}`,
              time: t,
              message: `${who} left`,
              tone: "system",
            });
          }
          return;
        }
        case "pong": {
          // Heartbeat ack — no UI surface.
          return;
        }
      }
    },
    [member_id],
  );

  // ── Action handlers ───────────────────────────────────────────────────
  const onAck = React.useCallback((task_id: string) => {
    sendRef.current?.("ack_task", { task_id });
    setTask((prev) =>
      prev.kind === "active" && prev.task_id === task_id
        ? { ...prev, acked: true }
        : prev,
    );
  }, []);

  const onComplete = React.useCallback(
    (task_id: string, outcome: TaskOutcome) => {
      sendRef.current?.("complete_task", { task_id, outcome });
    },
    [],
  );

  const onRequestHelp = React.useCallback(
    (task_id: string, reason: string) => {
      sendRef.current?.("request_help", { task_id, reason });
    },
    [],
  );

  const onDecline = React.useCallback(
    (task_id: string, reason: string) => {
      sendRef.current?.("decline_task", { task_id, reason });
      setTask({ kind: "idle" });
    },
    [],
  );

  const onIterationAccept = React.useCallback(() => {
    if (!iteration) return;
    sendRef.current?.("iteration_response", {
      task_id: iteration.task_id,
      accepted: true,
    });
    setIteration(null);
  }, [iteration]);

  const onIterationDismiss = React.useCallback(() => {
    if (!iteration) return;
    sendRef.current?.("iteration_response", {
      task_id: iteration.task_id,
      accepted: false,
    });
    setIteration(null);
  }, [iteration]);

  const onPause = React.useCallback(async () => {
    // Send a presence_update("stepped_away") — the lead sees it and can pause
    // server-side. We don't expose brigade_pause directly to non-leads.
    sendRef.current?.("presence_update", { state: "stepped_away" });
  }, []);

  const onExit = React.useCallback(async () => {
    sendRef.current?.("presence_update", { state: "stepped_away" });
    wsRef.current?.close(1000, "user_exit");
  }, []);

  const onPhotoUploaded = React.useCallback(
    (result: { photo_id: string; vision_pending: boolean }) => {
      // The actual analysis arrives over the WS as `recipe_iteration_suggested`
      // or as a `lead_message{event:"photo_analyzed"}`. We just log here.
      appendEvent({
        id: `photo-${result.photo_id}`,
        time: formatTime(Date.now()),
        message: result.vision_pending
          ? "Photo sent — analyzing…"
          : "Photo analyzed",
        tone: "system",
      });
    },
    [],
  );

  function appendEvent(entry: EventLogEntry) {
    setEvents((prev) =>
      // Newest first; cap at 30 retained.
      [entry, ...prev].slice(0, 30),
    );
  }

  // Explicit hard-link to current task id for the photo capture (so vision
  // gets the right context).
  const activeTaskId =
    task.kind === "active" || task.kind === "awaiting"
      ? task.task_id
      : task.kind === "done"
      ? task.task_id
      : null;

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl mx-auto text-cream-dim">
      {/* Sticky header */}
      <header className="sticky top-0 -mx-5 px-5 py-3 z-10 backdrop-blur bg-ink-deep/80 border-b border-cream-faint/10 mb-5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-serif text-2xl text-cream-dim truncate">
              {meal_id || "Cook"}
            </h1>
            <p className="text-xs text-cream-faint">
              {expected_duration_min ? `${expected_duration_min} min · ` : ""}
              <span aria-label="elapsed time">▶ {formatElapsed(elapsedMs)}</span>
            </p>
          </div>
          <ConnectionStatusBadge
            status={
              showReconnecting && status !== "connected"
                ? status === "disconnected"
                  ? "disconnected"
                  : "reconnecting"
                : status === "reconnecting" || status === "disconnected"
                ? "connecting"
                : status
            }
            detail={statusDetail}
          />
        </div>
      </header>

      <div className="space-y-4">
        {iteration && (
          <IterationSuggestion
            suggestion={iteration}
            onAccept={onIterationAccept}
            onDismiss={onIterationDismiss}
          />
        )}

        <YourTask
          state={task}
          onAck={onAck}
          onComplete={onComplete}
          onRequestHelp={onRequestHelp}
          onDecline={onDecline}
        />

        <OtherMembers members={others} />

        {steps.length > 0 && <RecipeTimeline steps={steps} />}

        <PhotoCapture
          cook_session_id={cook_session_id}
          member_id={member_id}
          task_id={activeTaskId}
          onUploaded={onPhotoUploaded}
        />

        <EventLog events={events} />

        <ExitCook
          cook_session_id={cook_session_id}
          onPause={onPause}
          onExit={onExit}
        />
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function fetchToken(
  cook_session_id: string,
  member_id: string,
): Promise<BrigadeTokenGrant | null> {
  try {
    const res = await fetch("/api/cook/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cook_session_id, member_id }),
    });
    if (!res.ok) return null;
    return (await res.json()) as BrigadeTokenGrant;
  } catch {
    return null;
  }
}

function initialOthers(
  brigade: BrigadeSummary | null,
  self: string,
): OtherMember[] {
  const list = brigade?.connected_members ?? [];
  return list
    .filter((m) => m.member_id !== self)
    .map((m) => ({
      member_id: m.member_id,
      presence:
        (m.presence as OtherMember["presence"]) ?? "unknown",
      current_task_title: m.current_task_id ?? null,
    }));
}

function upsertOther(prev: OtherMember[], member_id: string): OtherMember[] {
  if (prev.some((m) => m.member_id === member_id)) {
    return prev.map((m) =>
      m.member_id === member_id
        ? { ...m, presence: "in_kitchen_idle" }
        : m,
    );
  }
  return [
    ...prev,
    { member_id, presence: "in_kitchen_idle" } satisfies OtherMember,
  ];
}

function updateOtherTask(
  setter: React.Dispatch<React.SetStateAction<OtherMember[]>>,
  member_id: string,
  task_title: string | null,
) {
  setter((prev) => {
    const present = prev.some((m) => m.member_id === member_id);
    const next: OtherMember = {
      member_id,
      presence: task_title ? "busy_assigned" : "in_kitchen_idle",
      current_task_title: task_title,
    };
    if (present) {
      return prev.map((m) => (m.member_id === member_id ? next : m));
    }
    return [...prev, next];
  });
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

function humanPhase(data: unknown): string {
  if (!data || typeof data !== "object") return "Phase update";
  const o = data as Record<string, unknown>;
  if (typeof o.message === "string") return o.message;
  if ("paused" in o) return o.paused ? "Cook paused" : "Cook resumed";
  if (typeof o.completed === "number" && typeof o.total === "number") {
    return `Progress: ${o.completed}/${o.total}`;
  }
  return "Phase update";
}
