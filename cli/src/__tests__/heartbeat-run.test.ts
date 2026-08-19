import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { heartbeatRun } from "../commands/heartbeat-run.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const API_BASE = "http://localhost:3100";

const OPTIONS = {
  agentId: AGENT_ID,
  apiBase: API_BASE,
  apiKey: "board-token",
  source: "on_demand",
  trigger: "manual",
  timeoutMs: "0",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("heartbeat run polling", () => {
  beforeEach(() => {
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps a 15-second run visible without exhausting protected polling budgets", async () => {
    let nowMs = 0;
    const requestUrls: string[] = [];
    const logPollTimes: number[] = [];

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requestUrls.push(url.toString());

      if (url.pathname === `/api/agents/${AGENT_ID}`) {
        return jsonResponse({
          id: AGENT_ID,
          companyId: COMPANY_ID,
          name: "Builder",
          adapterType: "process",
        });
      }
      if (url.pathname === `/api/agents/${AGENT_ID}/wakeup`) {
        return jsonResponse({
          id: RUN_ID,
          companyId: COMPANY_ID,
          agentId: AGENT_ID,
          status: "queued",
        }, 202);
      }
      if (url.pathname === `/api/heartbeat-runs/${RUN_ID}/events`) {
        return jsonResponse([]);
      }
      if (url.pathname === `/api/heartbeat-runs/${RUN_ID}`) {
        return jsonResponse({
          id: RUN_ID,
          companyId: COMPANY_ID,
          agentId: AGENT_ID,
          status: nowMs >= 15_000 ? "succeeded" : "running",
          error: null,
        });
      }
      if (url.pathname === `/api/heartbeat-runs/${RUN_ID}/log`) {
        logPollTimes.push(nowMs);
        if (logPollTimes.length > 30) {
          return jsonResponse({ error: "too_many_requests", reason: "rate_limit" }, 429);
        }
        return jsonResponse({ content: "", nextOffset: 0 });
      }
      if (url.pathname === `/api/companies/${COMPANY_ID}/heartbeat-runs`) {
        return jsonResponse({ error: "too_many_requests", reason: "rate_limit" }, 429);
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await heartbeatRun(OPTIONS, {
      now: () => nowMs,
      wait: async (ms) => {
        nowMs += ms;
      },
    });

    const runStatusRequests = requestUrls.filter(
      (url) => new URL(url).pathname === `/api/heartbeat-runs/${RUN_ID}`,
    );
    const runListRequests = requestUrls.filter(
      (url) => new URL(url).pathname === `/api/companies/${COMPANY_ID}/heartbeat-runs`,
    );

    expect(nowMs).toBe(15_000);
    expect(runListRequests).toHaveLength(0);
    expect(runStatusRequests).toHaveLength(16);
    expect(logPollTimes).toEqual([0, 3_000, 6_000, 9_000, 12_000]);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("completed with status succeeded"));
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining("Lost visibility"));
    expect(process.exitCode).toBeUndefined();
  });

  it("reports lost visibility instead of a failed run when polling receives a 429", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        id: AGENT_ID,
        companyId: COMPANY_ID,
        name: "Builder",
        adapterType: "process",
      }))
      .mockResolvedValueOnce(jsonResponse({
        id: RUN_ID,
        companyId: COMPANY_ID,
        agentId: AGENT_ID,
        status: "queued",
      }, 202))
      .mockResolvedValueOnce(jsonResponse({ error: "too_many_requests", reason: "rate_limit" }, 429));
    vi.stubGlobal("fetch", fetchMock);

    await heartbeatRun(OPTIONS);

    const errors = vi.mocked(console.error).mock.calls.flat().join("\n");
    const logs = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(errors).toContain(`Lost visibility into heartbeat run ${RUN_ID}`);
    expect(errors).toContain("may still be running or may have completed");
    expect(errors).toContain("Polling stopped: too_many_requests");
    expect(errors).toContain(`paperclipai run get ${RUN_ID}`);
    expect(logs).not.toContain("completed with status failed");
    expect(process.exitCode).toBe(2);
  });

  it("does not relabel a still-running server run as timed out when only the CLI times out", async () => {
    let nowMs = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === `/api/agents/${AGENT_ID}`) {
        return jsonResponse({
          id: AGENT_ID,
          companyId: COMPANY_ID,
          name: "Builder",
          adapterType: "process",
        });
      }
      if (url.pathname === `/api/agents/${AGENT_ID}/wakeup`) {
        return jsonResponse({
          id: RUN_ID,
          companyId: COMPANY_ID,
          agentId: AGENT_ID,
          status: "queued",
        }, 202);
      }
      if (url.pathname === `/api/heartbeat-runs/${RUN_ID}/events`) {
        return jsonResponse([]);
      }
      if (url.pathname === `/api/heartbeat-runs/${RUN_ID}`) {
        return jsonResponse({
          id: RUN_ID,
          companyId: COMPANY_ID,
          agentId: AGENT_ID,
          status: "running",
          error: null,
        });
      }
      if (url.pathname === `/api/heartbeat-runs/${RUN_ID}/log`) {
        return jsonResponse({ content: "", nextOffset: 0 });
      }
      throw new Error(`Unexpected request: ${url.toString()}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await heartbeatRun({ ...OPTIONS, timeoutMs: "200" }, {
      now: () => nowMs,
      wait: async (ms) => {
        nowMs += ms;
      },
    });

    const errors = vi.mocked(console.error).mock.calls.flat().join("\n");
    const logs = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(errors).toContain(`Lost visibility into heartbeat run ${RUN_ID}. Last observed server status: running.`);
    expect(errors).toContain("CLI stopped polling after its 200ms timeout");
    expect(logs).not.toContain("completed with status timed_out");
    expect(process.exitCode).toBe(2);
  });

  it("still reports a server-confirmed failed run as failed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        id: AGENT_ID,
        companyId: COMPANY_ID,
        name: "Builder",
        adapterType: "process",
      }))
      .mockResolvedValueOnce(jsonResponse({
        id: RUN_ID,
        companyId: COMPANY_ID,
        agentId: AGENT_ID,
        status: "queued",
      }, 202))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({
        id: RUN_ID,
        companyId: COMPANY_ID,
        agentId: AGENT_ID,
        status: "failed",
        error: "provider failed",
      }));
    vi.stubGlobal("fetch", fetchMock);

    await heartbeatRun(OPTIONS);

    const errors = vi.mocked(console.error).mock.calls.flat().join("\n");
    const logs = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(logs).toContain(`Run ${RUN_ID} completed with status failed`);
    expect(logs).toContain("Error: provider failed");
    expect(errors).not.toContain("Lost visibility");
    expect(process.exitCode).toBe(1);
  });
});
