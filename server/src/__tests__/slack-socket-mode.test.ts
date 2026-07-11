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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

  it("schedules one reconnect when opening a Slack connection rejects", async () => {
    const sockets: FakeSocket[] = [];
    const openConnection = vi.fn()
      .mockRejectedValueOnce(new Error("connection open failed"))
      .mockResolvedValue("wss://socket.example.test");
    const connection = startSlackSocketMode({} as Db, {
      reconnectDelayMs: 40,
      openConnection,
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as never;
      },
    });

    await flushConnection();
    expect(sockets).toHaveLength(0);
    expect(openConnection).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(39);
    expect(openConnection).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await flushConnection();
    expect(openConnection).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(openConnection).toHaveBeenCalledTimes(2);

    connection?.close();
  });

  it("schedules one reconnect when socket construction throws", async () => {
    const socket = new FakeSocket();
    const createSocket = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("socket construction failed");
      })
      .mockReturnValue(socket as never);
    const connection = startSlackSocketMode({} as Db, {
      reconnectDelayMs: 30,
      openConnection: async () => "wss://socket.example.test",
      createSocket,
    });

    await flushConnection();
    expect(createSocket).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(29);
    expect(createSocket).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await flushConnection();
    expect(createSocket).toHaveBeenCalledTimes(2);
    expect(socket.listenerCount("message")).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(createSocket).toHaveBeenCalledTimes(2);

    connection?.close();
  });

  it("catches token resolution failures and schedules one reconnect", async () => {
    const resolveAppToken = vi.fn()
      .mockRejectedValueOnce(new Error("secret provider unavailable"))
      .mockResolvedValue("test-app-token");
    const openConnection = vi.fn(async () => "wss://socket.example.test");
    const socket = new FakeSocket();
    const connection = startSlackSocketMode({} as Db, {
      reconnectDelayMs: 20,
      resolveAppToken,
      openConnection,
      createSocket: () => socket as never,
    });

    await flushConnection();
    expect(openConnection).not.toHaveBeenCalled();
    expect(resolveAppToken).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(19);
    expect(resolveAppToken).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await flushConnection();
    expect(resolveAppToken).toHaveBeenCalledTimes(2);
    expect(openConnection).toHaveBeenCalledOnce();
    expect(socket.listenerCount("message")).toBe(1);

    connection?.close();
  });

  it("does not create a socket or timer when closed during an in-flight open", async () => {
    const pendingOpen = deferred<string | null>();
    const createSocket = vi.fn(() => new FakeSocket() as never);
    const connection = startSlackSocketMode({} as Db, {
      reconnectDelayMs: 10,
      openConnection: () => pendingOpen.promise,
      createSocket,
    });

    await flushConnection();
    connection?.close();
    pendingOpen.resolve("wss://socket.example.test");
    await flushConnection();

    expect(createSocket).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
