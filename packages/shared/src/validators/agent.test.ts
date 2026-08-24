import { describe, expect, it } from "vitest";
import { createAgentHireSchema, createAgentSchema, updateAgentSchema } from "./agent.js";

const legacyProfile = {
  label: "  Brand policy fallback  ",
  adapterConfig: {
    adapterType: "claude_local",
    model: "claude-sonnet-4-6",
  },
  legacyMetadata: {
    source: "pre-model-profile-v1",
  },
};

describe("agent runtime config validation", () => {
  it("round-trips legacy named profiles on update without normalizing unrelated fields", () => {
    const runtimeConfig = {
      heartbeat: { enabled: false, maxConcurrentRuns: 1 },
      modelProfiles: {
        cheap: {
          enabled: true,
          label: "  Cheap lane  ",
          adapterConfig: {
            model: "gpt-5.3-codex-spark",
            modelReasoningEffort: "low",
          },
          futureCheapField: { preserved: true },
        },
        "brand-policy-fallback": legacyProfile,
      },
      futureRuntimeField: { preserved: true },
    };

    const parsed = updateAgentSchema.parse({ runtimeConfig });

    expect(parsed.runtimeConfig).toEqual(runtimeConfig);
  });

  it("keeps create and hire inputs strict against new legacy named profiles", () => {
    const input = {
      name: "Legacy profile creator",
      adapterType: "codex_local",
      runtimeConfig: {
        modelProfiles: {
          cheap: { adapterConfig: { model: "gpt-5.3-codex-spark" } },
          "brand-policy-fallback": legacyProfile,
        },
      },
    };

    expect(createAgentSchema.safeParse(input).success).toBe(false);
    expect(createAgentHireSchema.safeParse(input).success).toBe(false);
  });

  it("still validates the supported cheap profile env bindings", () => {
    const result = updateAgentSchema.safeParse({
      runtimeConfig: {
        modelProfiles: {
          cheap: {
            adapterConfig: {
              env: { API_TOKEN: 123 },
            },
          },
          "brand-policy-fallback": legacyProfile,
        },
      },
    });

    expect(result.success).toBe(false);
  });
});

describe("agent pause attribution on update", () => {
  it("accepts a paused status with an optional pause reason", () => {
    expect(updateAgentSchema.safeParse({ status: "paused" }).success).toBe(true);
    expect(
      updateAgentSchema.safeParse({ status: "paused", pauseReason: "manual" }).success,
    ).toBe(true);
    expect(
      updateAgentSchema.safeParse({ status: "paused", pauseReason: "system" }).success,
    ).toBe(true);
  });

  it("rejects unknown pause reasons", () => {
    expect(
      updateAgentSchema.safeParse({ status: "paused", pauseReason: "because" }).success,
    ).toBe(false);
  });
});
