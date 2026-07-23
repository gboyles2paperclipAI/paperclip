import { describe, expect, it, vi } from "vitest";
import type { IssueThreadInteraction } from "@paperclipai/shared";
import {
  DEFAULT_APPROVAL_TTL_SECONDS,
  DEFAULT_INTERACTION_TTL_SECONDS,
  emitInteractionLifecycleNotification,
  expiresAtForInteraction,
  loadInteractionLifecycleConfig,
} from "./interaction-lifecycle.js";

const interaction = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "22222222-2222-4222-8222-222222222222",
  issueId: "33333333-3333-4333-8333-333333333333",
  kind: "request_confirmation",
  status: "pending",
  continuationPolicy: "none",
  title: "Approve rollout",
  summary: "Operator decision required",
  payload: {
    version: 1,
    prompt: "Approve?",
    expiresAt: "2026-08-06T00:00:00.000Z",
    escalated: false,
    originalInteractionId: null,
  },
  result: null,
  createdAt: "2026-07-23T00:00:00.000Z",
  updatedAt: "2026-07-23T00:00:00.000Z",
} as IssueThreadInteraction;

describe("interaction lifecycle configuration", () => {
  it("uses raised defaults and accepts bounded per-instance TTL overrides", () => {
    const defaults = loadInteractionLifecycleConfig({});
    expect(defaults).toMatchObject({
      interactionTtlSeconds: DEFAULT_INTERACTION_TTL_SECONDS,
      approvalTtlSeconds: DEFAULT_APPROVAL_TTL_SECONDS,
      notificationWebhookUrl: undefined,
    });
    expect(defaults.approvalTtlSeconds).toBeGreaterThan(defaults.interactionTtlSeconds);

    const configured = loadInteractionLifecycleConfig({
      PAPERCLIP_INTERACTION_TTL_SECONDS: "3600",
      PAPERCLIP_APPROVAL_TTL_SECONDS: "7200",
      PAPERCLIP_INTERACTION_NOTIFICATION_WEBHOOK_URL: "https://notify.example.test/cards",
    });
    expect(configured).toMatchObject({
      interactionTtlSeconds: 3600,
      approvalTtlSeconds: 7200,
      notificationWebhookUrl: "https://notify.example.test/cards",
    });
    expect(expiresAtForInteraction(
      "request_confirmation",
      new Date("2026-07-23T00:00:00.000Z"),
      configured,
    )?.toISOString()).toBe("2026-07-23T02:00:00.000Z");
  });

  it("emits creation and expiry events only when the webhook is configured", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(emitInteractionLifecycleNotification("interaction.created", interaction, {
      config: loadInteractionLifecycleConfig({}),
      fetchImpl,
    })).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();

    const config = loadInteractionLifecycleConfig({
      PAPERCLIP_INTERACTION_NOTIFICATION_WEBHOOK_URL: "https://notify.example.test/cards",
    });
    await expect(emitInteractionLifecycleNotification("interaction.created", interaction, {
      config,
      fetchImpl,
    })).resolves.toBe(true);
    await expect(emitInteractionLifecycleNotification("interaction.expired", {
      ...interaction,
      status: "expired",
    }, {
      config,
      fetchImpl,
    })).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const bodies = fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    expect(bodies.map((body) => body.event)).toEqual([
      "interaction.created",
      "interaction.expired",
    ]);
    expect(bodies[0]).toMatchObject({
      interactionId: interaction.id,
      expiresAt: interaction.payload.expiresAt,
      escalated: false,
      originalInteractionId: null,
    });
  });
});
