import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach } from "vitest";

const execMock = vi.fn();

vi.mock("@kubernetes/client-node", () => ({
  // Must be a real `function` (not an arrow function) so `new Exec(kc)` in
  // pod-exec.ts can invoke it as a constructor.
  Exec: vi.fn().mockImplementation(function MockExec() {
    return { exec: execMock };
  }),
}));

const { execInPod } = await import("../../src/pod-exec.js");

describe("execInPod", () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  it("returns success when the Kubernetes exec status callback reports success", async () => {
    execMock.mockImplementation((_namespace, _pod, _container, _command, stdout, stderr, _stdin, _tty, statusCallback) => {
      stdout.write("ok\n");
      statusCallback({ status: "Success" });
      // The real @kubernetes/client-node Exec ends both output streams once
      // it has processed the status frame; execInPod waits for both `end`
      // events before resolving so it never returns before all buffered
      // stdout/stderr bytes have been drained into its accumulators.
      stdout.end();
      stderr.end();
      return Promise.resolve(new EventEmitter());
    });

    const result = await execInPod({} as never, "ns", "pod-1", "agent", ["echo", "ok"]);
    expect(result).toEqual({ exitCode: 0, stdout: "ok\n", stderr: "" });
  });

  it("returns an execution failure if the websocket closes before a status frame", async () => {
    const ws = new EventEmitter();
    execMock.mockResolvedValue(ws);

    const resultPromise = execInPod({} as never, "ns", "pod-1", "agent", ["sleep", "1"]);
    await Promise.resolve();
    ws.emit("close", 1006, Buffer.from("connection lost"));

    await expect(resultPromise).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("websocket closed before status frame"),
    });
  });
});
