import { beforeEach, describe, expect, it, vi } from "vitest";
import { companyService } from "../services/companies.ts";
import { agentService } from "../services/agents.ts";

function createSelectSequenceDb(results: unknown[]) {
  const pending = [...results];
  const take = () => pending.shift() ?? [];
  const createChain = () => {
    const chain = {
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      leftJoin: vi.fn(() => chain),
      // usage-cost-estimates joins heartbeat_runs onto cost_events
      innerJoin: vi.fn(() => chain),
      groupBy: vi.fn(() => chain),
      then: vi.fn(
        (onFulfilled?: (value: unknown[]) => unknown, onRejected?: (err: unknown) => unknown) => {
          const value = take() as unknown[];
          const pendingResult = Promise.resolve(value);
          return typeof onFulfilled === "function" ? pendingResult.then(onFulfilled, onRejected) : pendingResult;
        },
      ),
    };
    return chain;
  };

  return {
    db: {
      select: vi.fn(() => createChain()),
    },
  };
}

describe("monthly spend hydration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("recomputes company spentMonthlyCents from the current utc month instead of returning stale stored values", async () => {
    const companyRow = {
      id: "company-1",
      name: "Paperclip",
      description: null,
      status: "active",
      issuePrefix: "PAP",
      issueCounter: 1,
      budgetMonthlyCents: 5000,
      spentMonthlyCents: 999999,
      requireBoardApprovalForNewAgents: false,
      brandColor: null,
      logoAssetId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    // list() then Promise.all(billed, estimate). Rows carry both billed and
    // estimate fields so either microtask order still hydrates 420 + 0.
    const liveSpendRow = {
      ...companyRow,
      companyId: "company-1",
      spentMonthlyCents: 420,
      estimated: 0,
    };
    const dbStub = createSelectSequenceDb([
      [companyRow],
      [liveSpendRow],
      [liveSpendRow],
    ]);

    const companies = companyService(dbStub.db as any);
    const [company] = await companies.list();

    expect(company.spentMonthlyCents).toBe(420);
  });

  it("recomputes agent spentMonthlyCents from the current utc month instead of returning stale stored values", async () => {
    const agentRow = {
      id: "agent-1",
      companyId: "company-1",
      name: "Budget Agent",
      role: "general",
      title: null,
      reportsTo: null,
      capabilities: null,
      adapterType: "claude-local",
      adapterConfig: {},
      runtimeConfig: {},
      budgetMonthlyCents: 5000,
      spentMonthlyCents: 999999,
      metadata: null,
      permissions: null,
      status: "idle",
      pauseReason: null,
      pausedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    // getById, then Promise.all(listCompany, billed, estimate). Combined rows
    // stay valid for any of those three thenables.
    const liveSpendRow = {
      ...agentRow,
      agentId: "agent-1",
      spentMonthlyCents: 175,
      estimated: 0,
    };
    const dbStub = createSelectSequenceDb([
      [agentRow],
      [liveSpendRow],
      [liveSpendRow],
      [liveSpendRow],
    ]);

    const agents = agentService(dbStub.db as any);
    const agent = await agents.getById("agent-1");

    expect(agent?.spentMonthlyCents).toBe(175);
  });
});
