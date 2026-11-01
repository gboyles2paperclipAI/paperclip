import { describe, expect, it } from "vitest";
import {
  createToolConnectionSchema,
  toolRedactedValueSummarySchema,
  toolTransportConfigSchema,
  updateToolConnectionSchema,
  updateToolMcpGatewaySchema,
  updateToolPolicySchema,
  updateToolProfileEntrySchema,
  updateToolProfileSchema,
  updateToolProfileWithEntriesSchema,
} from "./tool-access.js";

describe("tool access validators", () => {
  it("does not inject create defaults into sparse connection updates", () => {
    expect(updateToolConnectionSchema.parse({ name: "Renamed connection" })).toEqual({
      name: "Renamed connection",
    });
  });

  it("does not inject create defaults into sparse profile updates", () => {
    expect(updateToolProfileSchema.parse({ name: "Renamed profile" })).toEqual({
      name: "Renamed profile",
    });
  });

  it("does not inject create defaults into sparse profile entry updates", () => {
    expect(updateToolProfileEntrySchema.parse({ toolName: "renamed_tool" })).toEqual({
      toolName: "renamed_tool",
    });
  });

  it("does not inject create defaults into sparse profile-with-entries updates", () => {
    expect(updateToolProfileWithEntriesSchema.parse({ name: "Renamed profile" })).toEqual({
      name: "Renamed profile",
    });
  });

  it("does not inject create defaults into sparse gateway updates", () => {
    expect(updateToolMcpGatewaySchema.parse({ name: "Renamed gateway" })).toEqual({
      name: "Renamed gateway",
    });
  });

  it("does not inject create defaults into sparse policy updates", () => {
    expect(updateToolPolicySchema.parse({ name: "Renamed policy" })).toEqual({
      name: "Renamed policy",
    });
  });

  it("rejects raw credential-looking fields in transport config", () => {
    const parsed = toolTransportConfigSchema.safeParse({
      url: "https://example.test/mcp",
      headers: {
        Authorization: "Bearer raw-token",
      },
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain("credentialSecretRefs");
    }
  });

  it("accepts secret references for connection credentials", () => {
    const parsed = createToolConnectionSchema.safeParse({
      applicationId: "11111111-1111-4111-8111-111111111111",
      name: "GitHub fixture",
      connectionKind: "managed",
      transportConfig: { url: "https://example.test/mcp" },
      credentialSecretRefs: [
        {
          secretId: "22222222-2222-4222-8222-222222222222",
          configPath: "headers.Authorization",
          versionSelector: "latest",
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("keeps invocation payload summaries redacted and bounded", () => {
    const parsed = toolRedactedValueSummarySchema.parse({
      summary: "Redacted arguments: 2 fields omitted.",
      sha256: "a".repeat(64),
      redactedFields: ["headers.Authorization", "body.token"],
    });

    expect(parsed.redactedFields).toEqual(["headers.Authorization", "body.token"]);
  });
});
