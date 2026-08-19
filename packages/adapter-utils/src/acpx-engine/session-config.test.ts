import { describe, expect, it } from "vitest";
import { resolveAdvertisedSessionConfigOption } from "./session-config.js";

const effortRequest = {
  key: "reasoning_effort",
  value: "high",
  category: "thought_level",
};

describe("resolveAdvertisedSessionConfigOption", () => {
  it("keeps the Codex ACP protocol key when the session advertises it", () => {
    expect(resolveAdvertisedSessionConfigOption({
      details: {
        configOptions: [{ id: "reasoning_effort", category: "thought_level" }],
      },
    }, effortRequest)).toEqual(effortRequest);
  });

  it("uses the negotiated option id instead of assuming an adapter config key", () => {
    expect(resolveAdvertisedSessionConfigOption({
      details: {
        configOptions: [{ id: "modelReasoningEffort", category: "thought_level" }],
      },
    }, effortRequest)).toEqual({
      key: "modelReasoningEffort",
      value: "high",
      category: "thought_level",
    });
  });

  it("returns null when the negotiated session has no thought-level option", () => {
    expect(resolveAdvertisedSessionConfigOption({
      details: {
        configOptions: [
          { id: "mode", category: "mode" },
          { id: "model", category: "model" },
        ],
      },
    }, effortRequest)).toBeNull();
  });
});
