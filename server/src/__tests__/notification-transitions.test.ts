import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  approvals,
  companies,
  createDb,
  notificationTransitions,
} from "@paperclipai/db";
import {
  maybeNotifySlackForActivity,
  slackIntegrationService,
} from "../services/slack-integration.js";
import {
  canonicalTransitionJson,
  computeTransitionStateHash,
  evaluateNotificationTransition,
  recordNotificationTransition,
} from "../services/notification-transitions.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping durable notification transition tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function acceptingSlackFetch() {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ ok: true, ts: `${Date.now() / 1000}` }),
  }));
}

describe("transition state hashing", () => {
  it("is stable across key order and changes when any tuple member changes", () => {
    const base = {
      subject: "issue:abc",
      eventClass: "blocked",
      previousState: null,
      nextState: { status: "blocked", reason: "creds missing" },
      ownerIdentity: "agent-1",
    };
    const reordered = computeTransitionStateHash({
      ownerIdentity: "agent-1",
      nextState: { reason: "creds missing", status: "blocked" },
      previousState: null,
      eventClass: "blocked",
      subject: "issue:abc",
    });
    expect(computeTransitionStateHash(base)).toBe(reordered);
    expect(computeTransitionStateHash({ ...base, ownerIdentity: "agent-2" })).not.toBe(
      computeTransitionStateHash(base),
    );
    expect(
      computeTransitionStateHash({ ...base, nextState: { status: "blocked", reason: "other" } }),
    ).not.toBe(computeTransitionStateHash(base));
    expect(canonicalTransitionJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(
      canonicalTransitionJson({ a: [{ c: 3, d: 2 }], b: 1 }),
    );
  });

  it("always notifies when no durable store is reachable", async () => {
    const evaluation = await evaluateNotificationTransition(undefined, "not-a-uuid", {
      subject: "issue:abc",
      eventClass: "blocked",
      nextState: { status: "blocked" },
      ownerIdentity: null,
    });
    expect(evaluation).toMatchObject({ notify: true, recordable: false, reason: "no_store" });
  });
});

describeEmbeddedPostgres("durable transition-keyed notification dedup (R2.15)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-notification-transitions-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_ALERTS_CHANNEL_ID;
    delete process.env.SLACK_APPROVALS_CHANNEL_ID;
    await db.delete(notificationTransitions);
    await db.delete(approvals);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Transitions ${companyId.slice(0, 8)}`,
      issuePrefix: `NT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    return companyId;
  }

  function blockedEvent(companyId: string, issueId: string, overrides: Record<string, unknown> = {}) {
    return {
      db,
      companyId,
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: {
        status: "blocked",
        title: "Waiting for credentials",
        reason: "Help Scout credentials missing",
        assigneeAgentId: "11111111-1111-4111-8111-111111111111",
        ...overrides,
      },
    };
  }

  async function transitionRows(companyId: string) {
    return db
      .select()
      .from(notificationTransitions)
      .where(eq(notificationTransitions.companyId, companyId));
  }

  it("re-logging an unchanged failure state notifies zero times more, durably across service re-instantiation", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_ALERTS_CHANNEL_ID = "CALERTS";
    const fetchMock = acceptingSlackFetch();
    vi.stubGlobal("fetch", fetchMock);
    const companyId = await seedCompany();
    const issueId = randomUUID();

    await maybeNotifySlackForActivity(blockedEvent(companyId, issueId));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await maybeNotifySlackForActivity(blockedEvent(companyId, issueId));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const rows = await transitionRows(companyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subject: `issue:${issueId}`,
      eventClass: "blocked",
      notifyCount: 1,
    });

    // Restart-safety: the dedup state lives in the database, not in module or
    // service memory. A brand-new client (fresh process stand-in) still
    // suppresses the unchanged state.
    const restartedDb = createDb(tempDb!.connectionString);
    try {
      await maybeNotifySlackForActivity({ ...blockedEvent(companyId, issueId), db: restartedDb });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await (restartedDb as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
    }
  }, 20_000);

  it("a state change notifies exactly once and advances the stored transition", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_ALERTS_CHANNEL_ID = "CALERTS";
    const fetchMock = acceptingSlackFetch();
    vi.stubGlobal("fetch", fetchMock);
    const companyId = await seedCompany();
    const issueId = randomUUID();

    await maybeNotifySlackForActivity(blockedEvent(companyId, issueId));
    const [initial] = await transitionRows(companyId);

    await maybeNotifySlackForActivity(
      blockedEvent(companyId, issueId, { reason: "Waiting on rotated API key" }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The new state is suppressed on re-log, and the OLD state would now
    // re-notify (it is a change again) — transition-keyed, not seen-once.
    await maybeNotifySlackForActivity(
      blockedEvent(companyId, issueId, { reason: "Waiting on rotated API key" }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const rows = await transitionRows(companyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.notifyCount).toBe(2);
    expect(rows[0]!.stateHash).not.toBe(initial!.stateHash);
  }, 20_000);

  it("a missing previous transition always notifies (unknown is not unchanged)", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_ALERTS_CHANNEL_ID = "CALERTS";
    const fetchMock = acceptingSlackFetch();
    vi.stubGlobal("fetch", fetchMock);
    const companyId = await seedCompany();

    await maybeNotifySlackForActivity(blockedEvent(companyId, randomUUID()));
    await maybeNotifySlackForActivity(blockedEvent(companyId, randomUUID()));
    // Distinct subjects have no previous transition: both notify.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await transitionRows(companyId)).toHaveLength(2);
  }, 20_000);

  it("an unreadable stored previous state notifies instead of suppressing", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_ALERTS_CHANNEL_ID = "CALERTS";
    const fetchMock = acceptingSlackFetch();
    vi.stubGlobal("fetch", fetchMock);
    const companyId = await seedCompany();
    const issueId = randomUUID();

    await maybeNotifySlackForActivity(blockedEvent(companyId, issueId));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Corrupt the stored previous-state payload; the same event must notify
    // again rather than trusting an unreadable `_previous`.
    await db
      .update(notificationTransitions)
      .set({ acknowledgedChannels: { corrupted: true } })
      .where(
        and(
          eq(notificationTransitions.companyId, companyId),
          eq(notificationTransitions.subject, `issue:${issueId}`),
        ),
      );
    await maybeNotifySlackForActivity(blockedEvent(companyId, issueId));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 20_000);

  it("channel API failure leaves the transition unacknowledged and retryable until a post is accepted", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_ALERTS_CHANNEL_ID = "CALERTS";
    const responses = [
      { ok: false, error: "channel_not_found" },
      { ok: true }, // API success but NO message ts: still not accepted
      { ok: true, ts: "1710000000.000300" },
    ];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => responses.shift() ?? { ok: true, ts: "1710000000.000400" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const companyId = await seedCompany();
    const issueId = randomUUID();

    await maybeNotifySlackForActivity(blockedEvent(companyId, issueId));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await transitionRows(companyId)).toHaveLength(0);

    // Retry: API ok but no ts — acceptance requires the message id (R2.15).
    await maybeNotifySlackForActivity(blockedEvent(companyId, issueId));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await transitionRows(companyId)).toHaveLength(0);

    // Retry: accepted with ts — recorded, then suppressed.
    await maybeNotifySlackForActivity(blockedEvent(companyId, issueId));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const rows = await transitionRows(companyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.notifyCount).toBe(1);

    await maybeNotifySlackForActivity(blockedEvent(companyId, issueId));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 20_000);

  it("an unset channel configuration is a channel failure, never vacuous success", async () => {
    const fetchMock = acceptingSlackFetch();
    vi.stubGlobal("fetch", fetchMock);
    const companyId = await seedCompany();
    const issueId = randomUUID();

    // No SLACK_BOT_TOKEN / channel anywhere: nothing posted, nothing recorded.
    await maybeNotifySlackForActivity(blockedEvent(companyId, issueId));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await transitionRows(companyId)).toHaveLength(0);

    // Once the channel exists the same (still-unnotified) transition fires.
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_ALERTS_CHANNEL_ID = "CALERTS";
    await maybeNotifySlackForActivity(blockedEvent(companyId, issueId));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await transitionRows(companyId)).toHaveLength(1);
  }, 20_000);

  it("an owner change re-notifies an otherwise unchanged failure state", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_ALERTS_CHANNEL_ID = "CALERTS";
    const fetchMock = acceptingSlackFetch();
    vi.stubGlobal("fetch", fetchMock);
    const companyId = await seedCompany();
    const issueId = randomUUID();

    await maybeNotifySlackForActivity(blockedEvent(companyId, issueId));
    await maybeNotifySlackForActivity(
      blockedEvent(companyId, issueId, { assigneeAgentId: "22222222-2222-4222-8222-222222222222" }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const rows = await transitionRows(companyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.notifyCount).toBe(2);
  }, 20_000);

  it("keys the interaction-created and escalation families as transitions too", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_ALERTS_CHANNEL_ID = "CALERTS";
    process.env.SLACK_APPROVALS_CHANNEL_ID = "CAPPROVE";
    const fetchMock = acceptingSlackFetch();
    vi.stubGlobal("fetch", fetchMock);
    const companyId = await seedCompany();
    const issueId = randomUUID();
    const interactionId = randomUUID();

    const interactionEvent = {
      db,
      companyId,
      action: "issue.thread_interaction_created",
      entityType: "issue",
      entityId: issueId,
      details: {
        interactionId,
        interactionKind: "request_confirmation",
        interactionStatus: "pending",
        interactionTitle: "Approve the thing",
      },
    };
    await maybeNotifySlackForActivity(interactionEvent);
    await maybeNotifySlackForActivity(interactionEvent);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const escalationEvent = {
      db,
      companyId,
      action: "issue.escalation_requested",
      entityType: "issue",
      entityId: issueId,
      details: { type: "security_escalation", reason: "Suspicious login burst" },
    };
    await maybeNotifySlackForActivity(escalationEvent);
    await maybeNotifySlackForActivity(escalationEvent);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const rows = await transitionRows(companyId);
    expect(rows.map((row) => row.eventClass).sort()).toEqual(["escalation", "interaction_created"]);
  }, 20_000);

  it("dedupes approval-requested reposts and retries after channel failure", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_APPROVALS_CHANNEL_ID = "CAPPROVE";
    const responses = [
      { ok: false, error: "ratelimited" },
      { ok: true, ts: "1710000000.000500" },
      { ok: true, ts: "1710000000.000600" },
    ];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => responses.shift() ?? { ok: true, ts: "1710000000.000700" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const companyId = await seedCompany();
    const approval = await db
      .insert(approvals)
      .values({
        companyId,
        type: "request_board_approval",
        status: "pending",
        payload: { scope: "notification-transition-fixture" },
      })
      .returning()
      .then((rows) => rows[0]!);

    const slack = slackIntegrationService(db);
    // Channel failed: not accepted, nothing recorded, retryable.
    await slack.postApprovalRequested(approval.id);
    expect(await transitionRows(companyId)).toHaveLength(0);

    // Retry accepted and recorded.
    await slack.postApprovalRequested(approval.id);
    const rows = await transitionRows(companyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject: `approval:${approval.id}`, eventClass: "approval_requested" });

    // Re-post of the same pending approval is suppressed.
    await slack.postApprovalRequested(approval.id);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 20_000);

  it("records and upserts transitions through the module API", async () => {
    const companyId = await seedCompany();
    const descriptor = {
      subject: "routine:fixture",
      eventClass: "blocked",
      nextState: { status: "failing", reason: "probe timeout" },
      ownerIdentity: "monitor:host-watchdog",
    };
    const first = await evaluateNotificationTransition(db, companyId, descriptor);
    expect(first).toMatchObject({ notify: true, recordable: true, reason: "no_previous" });

    await recordNotificationTransition(db, {
      companyId,
      subject: descriptor.subject,
      eventClass: descriptor.eventClass,
      stateHash: first.stateHash!,
      nextState: descriptor.nextState,
      ownerIdentity: descriptor.ownerIdentity,
      acceptedChannels: {
        slack: { channel: "CALERTS", messageId: "1710.1", acceptedAt: new Date().toISOString() },
      },
    });

    const unchanged = await evaluateNotificationTransition(db, companyId, descriptor);
    expect(unchanged).toMatchObject({ notify: false, reason: "unchanged" });

    const ownerChanged = await evaluateNotificationTransition(db, companyId, {
      ...descriptor,
      ownerIdentity: "monitor:successor",
    });
    expect(ownerChanged).toMatchObject({ notify: true, reason: "changed" });
    expect(ownerChanged.previousState).toEqual(descriptor.nextState);
  }, 20_000);
});
