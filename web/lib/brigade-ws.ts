/**
 * BrigadeWS — typed WebSocket client for the CookingLeadAgent.
 *
 * Wraps a native browser WebSocket with:
 *   - typed inbound/outbound message envelopes (mirrors the worker contract
 *     in `worker/src/mise-graph/agents/cooking-lead-types.ts`)
 *   - exponential backoff reconnect (capped at 30s, with jitter)
 *   - status streaming so the UI can show "reconnecting…" after >2s
 *   - a clean `.close()` that doesn't trigger reconnect
 *
 * This client is the ONLY entry point the cook-mode UI uses to talk to the DO.
 * All raw JSON.parse / WebSocket events stay in this file.
 */
"use client";

// ── Wire-format types (must match worker/cooking-lead-types.ts) ──────────────

/** Outbound (DO → phone). */
export type BrigadeIncomingKind =
  | "welcome"
  | "task_assigned"
  | "task_unassigned"
  | "task_completed"
  | "task_started"
  | "task_help_requested"
  | "phase_progress"
  | "recipe_iteration_suggested"
  | "lead_message"
  | "session_ended"
  | "member_joined"
  | "member_left"
  | "pong";

/** Inbound (phone → DO). */
export type BrigadeOutgoingKind =
  | "hello"
  | "ping"
  | "presence_update"
  | "ack_task"
  | "complete_task"
  | "task_started"
  | "request_help"
  | "decline_task"
  | "iteration_response"
  | "photo_uploaded";

export interface BrigadeEnvelope<K extends string = string> {
  kind: K;
  emitted_at_ms?: number;
  cook_session_id?: string;
  member_id?: string;
  correlation_id?: string;
  data?: Record<string, unknown>;
}

export type IncomingMessage = BrigadeEnvelope<BrigadeIncomingKind>;
export type OutgoingMessage = BrigadeEnvelope<BrigadeOutgoingKind>;

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "closed"
  | "error";

export interface BrigadeWSConfig {
  /** wss://… url returned by `brigade_grant_token` (single-use token consumed on connect). */
  ws_url: string;
  /** member_id for our outgoing envelopes. */
  member_id: string;
  /** cook_session_id for our outgoing envelopes. */
  cook_session_id: string;
  /** Called for every parsed inbound message. */
  onMessage: (msg: IncomingMessage) => void;
  /** Called whenever the connection lifecycle changes. */
  onStatus?: (status: ConnectionStatus, detail?: string) => void;
  /**
   * Async callback invoked when a reconnect attempt is about to fire. The
   * caller MUST grant a fresh token (the previous one was single-use, already
   * consumed) and return a brand-new `ws_url`. If it throws or returns
   * a falsy value, reconnect is abandoned.
   */
  onReconnect?: () => Promise<string | null>;
  /** Initial backoff in ms. Default 500. */
  initialBackoffMs?: number;
  /** Cap on backoff. Default 30s. */
  maxBackoffMs?: number;
}

const DEFAULT_INITIAL_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

export class BrigadeWS {
  private ws: WebSocket | null = null;
  private currentUrl: string;
  private readonly cfg: Required<
    Omit<BrigadeWSConfig, "onStatus" | "onReconnect">
  > & {
    onStatus?: BrigadeWSConfig["onStatus"];
    onReconnect?: BrigadeWSConfig["onReconnect"];
  };
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;
  private status: ConnectionStatus = "disconnected";

  constructor(cfg: BrigadeWSConfig) {
    this.currentUrl = cfg.ws_url;
    this.cfg = {
      ws_url: cfg.ws_url,
      member_id: cfg.member_id,
      cook_session_id: cfg.cook_session_id,
      onMessage: cfg.onMessage,
      initialBackoffMs: cfg.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS,
      maxBackoffMs: cfg.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
      onStatus: cfg.onStatus,
      onReconnect: cfg.onReconnect,
    };
  }

  open(): void {
    this.intentionallyClosed = false;
    this.connect();
  }

  /**
   * Send a typed outgoing message. Auto-stamps `emitted_at_ms`,
   * `cook_session_id`, and `member_id` if missing.
   *
   * Returns `true` if the frame was queued on the socket; `false` if the
   * socket isn't OPEN (caller may retry after reconnect).
   */
  send<K extends BrigadeOutgoingKind>(
    kind: K,
    data?: Record<string, unknown>,
    extras?: Partial<OutgoingMessage>,
  ): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    const envelope: OutgoingMessage = {
      kind,
      emitted_at_ms: Date.now(),
      cook_session_id: this.cfg.cook_session_id,
      member_id: this.cfg.member_id,
      ...extras,
      data,
    };
    try {
      this.ws.send(JSON.stringify(envelope));
      return true;
    } catch {
      return false;
    }
  }

  /** Send a ping; pongs are surfaced via onMessage. */
  ping(): boolean {
    return this.send("ping");
  }

  /** Cleanly close. Does NOT trigger reconnect. */
  close(code = 1000, reason = "client_close"): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.ws?.close(code, reason);
    } catch {
      /* ignore */
    }
    this.setStatus("closed");
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  // ── private ─────────────────────────────────────────────────────────────

  private connect(): void {
    this.setStatus(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");
    try {
      this.ws = new WebSocket(this.currentUrl);
    } catch (err) {
      this.setStatus("error", err instanceof Error ? err.message : String(err));
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.setStatus("connected");
    };

    this.ws.onmessage = (ev: MessageEvent) => {
      let parsed: IncomingMessage | null = null;
      try {
        const text =
          typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data);
        parsed = JSON.parse(text) as IncomingMessage;
      } catch {
        return; // ignore malformed frames
      }
      if (!parsed || typeof parsed.kind !== "string") return;
      try {
        this.cfg.onMessage(parsed);
      } catch (err) {
        // never let a consumer error kill the socket
        // eslint-disable-next-line no-console
        console.error("[brigade-ws] onMessage handler threw", err);
      }
    };

    this.ws.onerror = () => {
      this.setStatus("error");
      // close handler runs after error; reconnect fires there.
    };

    this.ws.onclose = (ev: CloseEvent) => {
      this.ws = null;
      if (this.intentionallyClosed) {
        this.setStatus("closed");
        return;
      }
      // 4401 = auth_failed; do not retry blindly without a fresh token.
      const detail = `code=${ev.code}${ev.reason ? ` reason=${ev.reason}` : ""}`;
      this.setStatus("disconnected", detail);
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.intentionallyClosed) return;
    const attempt = this.reconnectAttempt++;
    const base = Math.min(
      this.cfg.maxBackoffMs,
      this.cfg.initialBackoffMs * Math.pow(2, attempt),
    );
    // ±25% jitter so a fleet of phones don't reconnect in lockstep.
    const jitter = base * (0.5 - Math.random()) * 0.5;
    const delay = Math.max(0, Math.round(base + jitter));
    this.setStatus("reconnecting", `attempt=${attempt + 1}, delay_ms=${delay}`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.refreshAndConnect();
    }, delay);
  }

  private async refreshAndConnect(): Promise<void> {
    if (this.intentionallyClosed) return;
    if (this.cfg.onReconnect) {
      try {
        const fresh = await this.cfg.onReconnect();
        if (!fresh) {
          this.setStatus("error", "reconnect_token_failed");
          // Schedule another attempt — token grant may be transient.
          this.scheduleReconnect();
          return;
        }
        this.currentUrl = fresh;
      } catch (err) {
        this.setStatus(
          "error",
          err instanceof Error ? err.message : String(err),
        );
        this.scheduleReconnect();
        return;
      }
    }
    this.connect();
  }

  private setStatus(status: ConnectionStatus, detail?: string): void {
    this.status = status;
    this.cfg.onStatus?.(status, detail);
  }
}
