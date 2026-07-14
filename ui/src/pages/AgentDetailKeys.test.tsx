// @vitest-environment node

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { normalizeAgentKey, type AgentKey } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { KeysTab } from "./AgentDetail";

const legacyKey = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "legacy automation",
  scope: { kind: "standard" },
  createdAt: new Date("2026-04-11T00:00:00.000Z"),
  revokedAt: null,
} as unknown as AgentKey;

describe("agent detail API keys", () => {
  it("normalizes a legacy inventory payload that omits provenance and last use", () => {
    expect(normalizeAgentKey(legacyKey)).toEqual(expect.objectContaining({
      creation: {
        actorType: "unknown",
        actorId: null,
        source: "unknown",
      },
      lastUsedAt: null,
    }));
  });

  it("renders a cached legacy key without crashing", () => {
    const agentId = "11111111-1111-4111-8111-111111111111";
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      },
    });
    queryClient.setQueryData(queryKeys.agents.keys(agentId), [legacyKey]);

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <KeysTab agentId={agentId} />
      </QueryClientProvider>,
    );

    expect(html).toContain("legacy automation");
    expect(html).toContain("Creation provenance unavailable");
    expect(html).toContain("Never used");
  });
});
