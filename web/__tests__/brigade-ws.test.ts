/**
 * Tests for BrigadeWS — the typed WS client for cook mode.
 *
 * Covers:
 *   1. open() → connecting → connected
 *   2. inbound messages → onMessage callback
 *   3. send() typed envelopes auto-stamp cook_session_id + member_id
 *   4. close on the socket fires reconnect with backoff (and refreshes token)
 *   5. close() does NOT trigger reconnect
 *   6. malformed JSON frames are ignored
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  BrigadeWS,
  type IncomingMessage,
  type ConnectionStatus,
} from "../lib/brigade-ws";
import { MockWebSocket, installMockWebSocket } from "./mock-ws";

describe("BrigadeWS", () => {
  let teardown: () => void;
  let received: IncomingMessage[];
  let statuses: ConnectionStatus[];

  beforeEach(() => {
    teardown = installMockWebSocket();
    received = [];
    statuses = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    teardown();
    vi.useRealTimers();
  });

  it("connects and surfaces inbound frames", () => {
    const ws = new BrigadeWS({
      ws_url: "wss://example/ws?token=abc&member_id=mem_1",
      cook_session_id: "cs_1",
      member_id: "mem_1",
      onMessage: (m) => received.push(m),
      onStatus: (s) => statuses.push(s),
    });
    ws.open();

    expect(MockWebSocket.instances.length).toBe(1);
    expect(MockWebSocket.instances[0].url).toContain("token=abc");
    expect(statuses).toContain("connecting");

    MockWebSocket.instances[0].acceptOpen();
    expect(statuses).toContain("connected");

    MockWebSocket.instances[0].emit({
      kind: "welcome",
      cook_session_id: "cs_1",
      member_id: "mem_1",
    });
    expect(received.length).toBe(1);
    expect(received[0].kind).toBe("welcome");

    ws.close();
  });

  it("send() auto-stamps cook_session_id + member_id", () => {
    const ws = new BrigadeWS({
      ws_url: "wss://example/ws?token=t",
      cook_session_id: "cs_42",
      member_id: "mem_alice",
      onMessage: () => {},
    });
    ws.open();
    MockWebSocket.instances[0].acceptOpen();

    const ok = ws.send("complete_task", { task_id: "t1", outcome: "success" });
    expect(ok).toBe(true);

    const last = MockWebSocket.instances[0].lastSent() as Record<string, unknown>;
    expect(last.kind).toBe("complete_task");
    expect(last.cook_session_id).toBe("cs_42");
    expect(last.member_id).toBe("mem_alice");
    expect(typeof last.emitted_at_ms).toBe("number");
    expect((last.data as Record<string, unknown>).task_id).toBe("t1");

    ws.close();
  });

  it("send() returns false when socket is not OPEN", () => {
    const ws = new BrigadeWS({
      ws_url: "wss://example/ws",
      cook_session_id: "cs_1",
      member_id: "mem_1",
      onMessage: () => {},
    });
    ws.open();
    // Not yet open
    expect(ws.send("ping")).toBe(false);

    MockWebSocket.instances[0].acceptOpen();
    expect(ws.send("ping")).toBe(true);

    ws.close();
  });

  it("malformed inbound JSON is ignored", () => {
    const ws = new BrigadeWS({
      ws_url: "wss://example/ws",
      cook_session_id: "cs_1",
      member_id: "mem_1",
      onMessage: (m) => received.push(m),
    });
    ws.open();
    MockWebSocket.instances[0].acceptOpen();
    MockWebSocket.instances[0].onmessage?.({ data: "not-json" });
    MockWebSocket.instances[0].onmessage?.({ data: '{"no_kind":true}' });
    expect(received.length).toBe(0);
    ws.close();
  });

  it("reconnects with exponential backoff and calls onReconnect for a fresh url", async () => {
    const onReconnect = vi
      .fn()
      .mockResolvedValueOnce("wss://example/ws?token=fresh1");
    const ws = new BrigadeWS({
      ws_url: "wss://example/ws?token=stale",
      cook_session_id: "cs_1",
      member_id: "mem_1",
      onMessage: () => {},
      onStatus: (s) => statuses.push(s),
      onReconnect,
      initialBackoffMs: 100,
      maxBackoffMs: 1_000,
    });
    ws.open();
    MockWebSocket.instances[0].acceptOpen();
    expect(statuses).toContain("connected");

    // Simulate the network dropping the connection
    MockWebSocket.instances[0].forceClose(1006, "abnormal", false);
    expect(statuses).toContain("disconnected");

    // The reconnect schedule should fire after the (jittered) initial delay.
    // We tick well past the upper jittered bound to deflake.
    await vi.advanceTimersByTimeAsync(200);
    // Exhaust microtasks — onReconnect's promise has to resolve.
    await Promise.resolve();
    await Promise.resolve();

    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    expect(MockWebSocket.instances[1].url).toContain("fresh1");

    ws.close();
  });

  it("close() suppresses reconnect", async () => {
    const onReconnect = vi.fn().mockResolvedValue("wss://fresh");
    const ws = new BrigadeWS({
      ws_url: "wss://example/ws",
      cook_session_id: "cs_1",
      member_id: "mem_1",
      onMessage: () => {},
      onReconnect,
      initialBackoffMs: 50,
    });
    ws.open();
    MockWebSocket.instances[0].acceptOpen();
    ws.close(1000, "user_exit");

    await vi.advanceTimersByTimeAsync(500);
    expect(onReconnect).not.toHaveBeenCalled();
  });
});
