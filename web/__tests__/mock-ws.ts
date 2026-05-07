/**
 * MockWebSocket — a tiny in-memory stand-in for the browser WebSocket.
 *
 * Used by:
 *   - vitest tests for `BrigadeWS` (no real network)
 *   - storybook stories that need to drive task assignments / iteration
 *     suggestions interactively
 *
 * API mirrors the bits of WebSocket BrigadeWS uses: readyState, onopen,
 * onmessage, onerror, onclose, send(), close(). Does NOT honor the URL —
 * just records it on the instance for assertion.
 */

export type MockEventName = "open" | "message" | "error" | "close";

export interface MockOpenLike {}
export interface MockMessageLike {
  data: string | ArrayBuffer;
}
export interface MockCloseLike {
  code: number;
  reason: string;
  wasClean: boolean;
}

export class MockWebSocket {
  static OPEN = 1 as const;
  static CONNECTING = 0 as const;
  static CLOSING = 2 as const;
  static CLOSED = 3 as const;

  static instances: MockWebSocket[] = [];

  url: string;
  readyState: 0 | 1 | 2 | 3 = MockWebSocket.CONNECTING;
  sent: string[] = [];

  onopen: ((ev: MockOpenLike) => void) | null = null;
  onmessage: ((ev: MockMessageLike) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: MockCloseLike) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  /** Simulate a successful connect. */
  acceptOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({});
  }

  /** Simulate the server sending us a frame. */
  emit(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  /** Simulate the server (or network) dropping us. */
  forceClose(code = 1006, reason = "abnormal", wasClean = false) {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean });
  }

  /** Last frame the client sent (parsed as JSON when possible). */
  lastSent(): unknown {
    if (this.sent.length === 0) return null;
    const raw = this.sent[this.sent.length - 1];
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  // ── WebSocket API surface ─────────────────────────────────────────────
  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1000, reason = "normal") {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean: true });
  }

  static reset() {
    MockWebSocket.instances = [];
  }
}

/**
 * Install MockWebSocket as the global WebSocket for the duration of a test.
 * Returns a teardown function.
 */
export function installMockWebSocket(): () => void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const previous = (globalThis as any).WebSocket;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).WebSocket = MockWebSocket;
  return () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).WebSocket = previous;
    MockWebSocket.reset();
  };
}
