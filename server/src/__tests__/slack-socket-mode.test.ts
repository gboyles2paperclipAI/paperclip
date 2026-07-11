import { EventEmitter } from "node:events";
import type { Db } from "@paperclipai/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSlackApprovalInteraction, startSlackSocketMode } from "../services/slack-integration.js";

class FakeSocket extends EventEmitter {
  readyState = 1;
  readonly send = vi.fn();
  readonly close = vi.fn(() => {
    this.readyState = 3;
  });
}

async function flushConnection() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("Slack Socket Mode lifecycle", () => {
  const originalAppToken = process.env.SLACK_APP_TOKEN;

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.SLACK_APP_TOKEN = "test-app-token";
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalAppToken === undefined) delete process.env.SLACK_APP_TOKEN;
    else process.env.SLACK_APP_TOKEN = originalAppToken;
  });

  it("does not retain the full interactive payload after parsing", () => {
    const interaction = parseSlackApprovalInteraction({
      team: { id: "T123" },
      channel: { id: "C123" },
      user: { id: "U123" },
      actions: [{ action_id: "approve", value: JSON.stringify({ approval_id: "approval-1", action: "approve" }) }],
      response_url: "https://example.test/response",
      large_unused_payload: "x".repeat(10_000),
    });

    expect(interaction).not.toHaveProperty("rawPayload");
  });

  it("detaches listeners from closed sockets and backs off until a hello envelope", async () => {
    const sockets: FakeSocket[] = [];
    const openConnection = vi.fn(async () => "wss://socket.example.test");
    const connection = startSlackSocketMode({} as Db, {
      reconnectDelayMs: 100,
      openConnection,
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as never;
      },
    });

    await flushConnection();
    expect(sockets).toHaveLength(1);
    const first = sockets[0]!;
    expect(first.listenerCount("message")).toBe(1);

    first.emit("close");
    expect(first.eventNames()).toEqual([]);
    await vi.advanceTimersByTimeAsync(99);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushConnection();
    expect(sockets).toHaveLength(2);

    const second = sockets[1]!;
    second.emit("close");
    expect(second.eventNames()).toEqual([]);
    await vi.advanceTimersByTimeAsync(199);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await flushConnection();
    expect(sockets).toHaveLength(3);

    const third = sockets[2]!;
    third.emit("message", Buffer.from(JSON.stringify({ type: "hello" })));
    third.emit("close");
    await vi.advanceTimersByTimeAsync(100);
    await flushConnection();
    expect(sockets).toHaveLength(4);
    expect(openConnection).toHaveBeenCalledTimes(4);

    const fourth = sockets[3]!;
    connection?.close();
    expect(fourth.close).toHaveBeenCalledOnce();
    expect(fourth.listenerCount("message")).toBe(0);
  });

  it("cleans up a socket before reconnecting after a Slack disconnect envelope", async () => {
    const sockets: FakeSocket[] = [];
    const connection = startSlackSocketMode({} as Db, {
      reconnectDelayMs: 25,
      openConnection: async () => "wss://socket.example.test",
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as never;
      },
    });

    await flushConnection();
    const first = sockets[0]!;
    first.emit("message", Buffer.from(JSON.stringify({ type: "disconnect", reason: "refresh_requested" })));

    expect(first.close).toHaveBeenCalledOnce();
    expect(first.listenerCount("message")).toBe(0);
    await vi.advanceTimersByTimeAsync(25);
    await flushConnection();
    expect(sockets).toHaveLength(2);

    connection?.close();
  });
});
