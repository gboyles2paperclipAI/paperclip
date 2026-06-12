import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Mock fetch before importing the module under test
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock DB
const mockDb = {
  selectDistinct: vi.fn(),
};

import {
  parseModelFromQuotaError,
  formatResetWindow,
  fireQuotaExhaustionAlert,
  countAffectedCodexAgents,
} from "../services/quota-exhaustion-alert.js";
import type { QuotaExhaustionAlertInput } from "../services/quota-exhaustion-alert.js";

function makeInput(overrides: Partial<QuotaExhaustionAlertInput> = {}): QuotaExhaustionAlertInput {
  return {
    companyId: "company-1",
    adapterType: "codex_local",
    model: "gpt-5.3-codex-spark",
    retryNotBefore: "2026-06-11T09:00:00.000Z",
    errorMessage:
      "You've hit your usage limit for gpt-5.3-codex-spark. Switch to another model now, or try again at 9 AM PT.",
    db: mockDb as never,
    ...overrides,
  };
}

function makeMockDbWithAgents(agentIds: string[]) {
  const db = {
    selectDistinct: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(agentIds.map((id) => ({ agentId: id }))),
        }),
      }),
    }),
  };
  return db as never;
}

describe("parseModelFromQuotaError", () => {
  it("extracts model name from standard quota error message", () => {
    expect(
      parseModelFromQuotaError(
        "You've hit your usage limit for gpt-5.3-codex-spark. Switch to another model now, or try again at 9 AM PT.",
      ),
    ).toBe("gpt-5.3-codex-spark");
  });

  it("handles curly apostrophe variant", () => {
    expect(
      parseModelFromQuotaError(
        "You’ve hit your usage limit for gpt-5.3-codex-spark. Switch to another model now.",
      ),
    ).toBe("gpt-5.3-codex-spark");
  });

  it("returns null for unrelated messages", () => {
    expect(parseModelFromQuotaError("Process exited with code 1")).toBeNull();
    expect(parseModelFromQuotaError(null)).toBeNull();
    expect(parseModelFromQuotaError("")).toBeNull();
  });
});

describe("formatResetWindow", () => {
  it("formats a valid ISO date as UTC string", () => {
    const result = formatResetWindow("2026-06-11T09:00:00.000Z");
    expect(result).toContain("2026");
    expect(result).not.toBe("unknown");
  });

  it("returns unknown for null or invalid dates", () => {
    expect(formatResetWindow(null)).toBe("unknown");
    expect(formatResetWindow("not-a-date")).toBe("unknown");
  });
});

describe("fireQuotaExhaustionAlert", () => {
  let savedWebhookUrl: string | undefined;

  beforeEach(() => {
    savedWebhookUrl = process.env.DISCORD_OPS_WEBHOOK_URL;
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  afterEach(() => {
    if (savedWebhookUrl === undefined) {
      delete process.env.DISCORD_OPS_WEBHOOK_URL;
    } else {
      process.env.DISCORD_OPS_WEBHOOK_URL = savedWebhookUrl;
    }
  });

  it("does not call fetch when DISCORD_OPS_WEBHOOK_URL is not set", async () => {
    delete process.env.DISCORD_OPS_WEBHOOK_URL;
    await fireQuotaExhaustionAlert(makeInput({ db: makeMockDbWithAgents([]) }));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not call fetch for non-codex_local adapters", async () => {
    process.env.DISCORD_OPS_WEBHOOK_URL = "https://discord.com/api/webhooks/test";
    await fireQuotaExhaustionAlert(
      makeInput({ adapterType: "claude_local", db: makeMockDbWithAgents([]) }),
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("posts a Discord embed with correct content when quota is exhausted", async () => {
    process.env.DISCORD_OPS_WEBHOOK_URL = "https://discord.com/api/webhooks/test";
    const db = makeMockDbWithAgents(["agent-1", "agent-2", "agent-3"]);

    await fireQuotaExhaustionAlert(makeInput({ db, model: "gpt-5.3-codex-spark" }));

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://discord.com/api/webhooks/test");
    expect(init.method).toBe("POST");

    const body = JSON.parse(init.body as string);
    expect(body.embeds).toHaveLength(1);
    const embed = body.embeds[0];
    expect(embed.title).toContain("Quota Exhausted");
    expect(embed.title).toContain("codex_local");

    const fieldValues = embed.fields.map((f: { name: string; value: string }) => f.value);
    expect(fieldValues).toContain("gpt-5.3-codex-spark");
    expect(fieldValues).toContain("3"); // 3 affected agents
  });

  it("uses model parsed from error message when model field is null", async () => {
    process.env.DISCORD_OPS_WEBHOOK_URL = "https://discord.com/api/webhooks/test";
    // Use a distinct companyId to avoid dedup collision with earlier tests.
    await fireQuotaExhaustionAlert(
      makeInput({ companyId: "company-parsed-model", model: null, db: makeMockDbWithAgents([]) }),
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    const modelField = body.embeds[0].fields.find((f: { name: string }) => f.name === "Model");
    expect(modelField?.value).toBe("gpt-5.3-codex-spark");
  });

  it("falls back to 'unknown' model when error message has no quota pattern", async () => {
    process.env.DISCORD_OPS_WEBHOOK_URL = "https://discord.com/api/webhooks/test";
    await fireQuotaExhaustionAlert(
      makeInput({ model: null, errorMessage: "Some other error", db: makeMockDbWithAgents([]) }),
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    const modelField = body.embeds[0].fields.find((f: { name: string }) => f.name === "Model");
    expect(modelField?.value).toBe("unknown");
  });

  it("does not fire a second alert for the same company+model within the dedup window", async () => {
    process.env.DISCORD_OPS_WEBHOOK_URL = "https://discord.com/api/webhooks/test";
    const db = makeMockDbWithAgents(["agent-1"]);
    const input = makeInput({ db, model: "dedup-test-model-unique" });

    await fireQuotaExhaustionAlert(input);
    await fireQuotaExhaustionAlert(input);

    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("does not throw when Discord webhook returns non-OK status", async () => {
    process.env.DISCORD_OPS_WEBHOOK_URL = "https://discord.com/api/webhooks/test";
    mockFetch.mockResolvedValue({ ok: false, status: 429 });

    await expect(
      fireQuotaExhaustionAlert(
        makeInput({ model: "fail-test-model-unique", db: makeMockDbWithAgents([]) }),
      ),
    ).resolves.toBeUndefined();
  });
});

describe("countAffectedCodexAgents", () => {
  it("returns count of distinct agents with quota_exhausted codex_local runs", async () => {
    const db = makeMockDbWithAgents(["agent-a", "agent-b"]);
    const count = await countAffectedCodexAgents(db, "company-1");
    expect(count).toBe(2);
  });

  it("returns 0 when no agents are affected", async () => {
    const db = makeMockDbWithAgents([]);
    const count = await countAffectedCodexAgents(db, "company-1");
    expect(count).toBe(0);
  });
});
