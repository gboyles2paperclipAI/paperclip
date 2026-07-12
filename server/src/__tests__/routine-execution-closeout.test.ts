import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { HttpError } from "../errors.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("routine execution closeout", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-closeout-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCloseout(input: {
    status?: string;
    executionState?: Record<string, unknown> | null;
    executionPolicy?: Record<string, unknown> | null;
    assigneeAgentId?: string;
    checkoutRunId?: string;
  } = {}) {
    const companyId = randomUUID();
    const actorAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const actorRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Routine Closeout Co",
      issuePrefix: "RCO",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: actorAgentId,
        companyId,
        name: "Routine Operator",
        role: "operator",
        status: "active",
        permissions: { triageAuthority: true },
      },
      {
        id: reviewerAgentId,
        companyId,
        name: "Reviewer",
        role: "reviewer",
        status: "active",
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: actorRunId,
      companyId,
      agentId: actorAgentId,
      status: "running",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Run scheduled maintenance",
      status: input.status ?? "in_progress",
      assigneeAgentId: input.assigneeAgentId ?? actorAgentId,
      checkoutRunId: input.checkoutRunId ?? actorRunId,
      executionRunId: actorRunId,
      originKind: "routine_execution",
      executionState: input.executionState ?? null,
      executionPolicy: input.executionPolicy ?? null,
      priority: "medium",
    });
    return { companyId, actorAgentId, reviewerAgentId, actorRunId, issueId };
  }

  it("starts a required review stage instead of persisting the request null assertion", async () => {
    const ids = await seedCloseout();
    await db.update(issues).set({
      executionPolicy: {
        stages: [{ type: "review", participants: [{ type: "agent", agentId: ids.reviewerAgentId }] }],
      },
    }).where(eq(issues.id, ids.issueId));

    const result = await issueService(db).closeRoutineExecution(ids.issueId, {
      companyId: ids.companyId,
      actorAgentId: ids.actorAgentId,
      actorRunId: ids.actorRunId,
      commentBody: "Routine work complete; ready for review.",
    });

    expect(result.issue).toMatchObject({
      status: "in_review",
      assigneeAgentId: ids.reviewerAgentId,
      executionState: {
        status: "pending",
        currentStageType: "review",
      },
    });
    expect(result.patch.executionState).toMatchObject({ status: "pending", currentStageType: "review" });
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, ids.issueId));
    expect(comments).toHaveLength(1);
  });

  it.each([
    ["a staged execution state", "executionState"],
    ["a reassigned owner", "assigneeAgentId"],
    ["a changed checkout", "checkoutRunId"],
  ] as const)("rejects without clearing or commenting when the locked row has %s", async (_name, mutationKind) => {
    const ids = await seedCloseout();
    const competingRunId = randomUUID();
    if (mutationKind === "checkoutRunId") {
      await db.insert(heartbeatRuns).values({
        id: competingRunId,
        companyId: ids.companyId,
        agentId: ids.actorAgentId,
        status: "running",
      });
    }
    const mutation = mutationKind === "executionState"
      ? { executionState: { status: "pending" } }
      : mutationKind === "assigneeAgentId"
        ? { assigneeAgentId: ids.reviewerAgentId }
        : { checkoutRunId: competingRunId };
    await db.update(issues).set(mutation).where(eq(issues.id, ids.issueId));

    await expect(issueService(db).closeRoutineExecution(ids.issueId, {
      companyId: ids.companyId,
      actorAgentId: ids.actorAgentId,
      actorRunId: ids.actorRunId,
      commentBody: "Must not be persisted.",
    })).rejects.toMatchObject<HttpError>({ status: 409 });

    const [stored] = await db.select().from(issues).where(eq(issues.id, ids.issueId));
    if ("executionState" in mutation) expect(stored?.executionState).toEqual(mutation.executionState);
    if ("assigneeAgentId" in mutation) expect(stored?.assigneeAgentId).toBe(mutation.assigneeAgentId);
    if ("checkoutRunId" in mutation) expect(stored?.checkoutRunId).toBe(mutation.checkoutRunId);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, ids.issueId));
    expect(comments).toHaveLength(0);
  });

  it("rejects an already-done replay without duplicating its comment", async () => {
    const ids = await seedCloseout({ status: "done", checkoutRunId: undefined });

    await expect(issueService(db).closeRoutineExecution(ids.issueId, {
      companyId: ids.companyId,
      actorAgentId: ids.actorAgentId,
      actorRunId: ids.actorRunId,
      commentBody: "Duplicate completion.",
    })).rejects.toMatchObject<HttpError>({ status: 409, details: { reason: "already_done" } });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, ids.issueId));
    expect(comments).toHaveLength(0);
  });
});
