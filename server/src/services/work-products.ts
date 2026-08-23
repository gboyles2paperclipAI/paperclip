import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueWorkProducts } from "@paperclipai/db";
import type { IssueWorkProduct } from "@paperclipai/shared";
import {
  assertDecisionFreezeMutationAllowed,
  deriveDecisionFreezeActorType,
} from "./decision-freeze.js";

type IssueWorkProductRow = typeof issueWorkProducts.$inferSelect;

/** Actor context for the in-transaction decision-freeze gate (stack-review B). */
export type WorkProductActor = {
  agentId?: string | null;
  userId?: string | null;
  actorType?: string | null;
};

function toIssueWorkProduct(row: IssueWorkProductRow): IssueWorkProduct {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId ?? null,
    issueId: row.issueId,
    executionWorkspaceId: row.executionWorkspaceId ?? null,
    runtimeServiceId: row.runtimeServiceId ?? null,
    type: row.type as IssueWorkProduct["type"],
    provider: row.provider,
    externalId: row.externalId ?? null,
    title: row.title,
    url: row.url ?? null,
    status: row.status,
    reviewState: row.reviewState as IssueWorkProduct["reviewState"],
    isPrimary: row.isPrimary,
    healthStatus: row.healthStatus as IssueWorkProduct["healthStatus"],
    summary: row.summary ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    sourceTrust: row.sourceTrust ?? null,
    createdByRunId: row.createdByRunId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function workProductService(db: Db) {
  // Service-level decision-freeze gate (R2.2/R3.3, stack-review B): every
  // work-product write — create, mutate, delete — runs the agent gate inside
  // the same transaction as the write, so route-bypassing callers are covered.
  async function assertWorkProductMutationAllowed(
    tx: Db,
    companyId: string,
    issueId: string,
    actor: WorkProductActor | undefined,
  ) {
    await assertDecisionFreezeMutationAllowed(tx, companyId, issueId, {
      type: deriveDecisionFreezeActorType({
        actorType: actor?.actorType ?? null,
        actorAgentId: actor?.agentId ?? null,
        actorUserId: actor?.userId ?? null,
      }),
      agentId: actor?.agentId ?? null,
    });
  }

  return {
    listForIssue: async (issueId: string) => {
      const rows = await db
        .select()
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId))
        .orderBy(desc(issueWorkProducts.isPrimary), desc(issueWorkProducts.updatedAt));
      return rows.map(toIssueWorkProduct);
    },

    getById: async (id: string) => {
      const row = await db
        .select()
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.id, id))
        .then((rows) => rows[0] ?? null);
      return row ? toIssueWorkProduct(row) : null;
    },

    createForIssue: async (
      issueId: string,
      companyId: string,
      data: Omit<typeof issueWorkProducts.$inferInsert, "issueId" | "companyId">,
      actor?: WorkProductActor,
    ) => {
      const row = await db.transaction(async (tx) => {
        await assertWorkProductMutationAllowed(tx as unknown as Db, companyId, issueId, actor);
        if (data.isPrimary) {
          await tx
            .update(issueWorkProducts)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(issueWorkProducts.companyId, companyId),
                eq(issueWorkProducts.issueId, issueId),
                eq(issueWorkProducts.type, data.type),
              ),
            );
        }
        return await tx
          .insert(issueWorkProducts)
          .values({
            ...data,
            companyId,
            issueId,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
      });
      return row ? toIssueWorkProduct(row) : null;
    },

    update: async (
      id: string,
      patch: Partial<typeof issueWorkProducts.$inferInsert>,
      actor?: WorkProductActor,
    ) => {
      const row = await db.transaction(async (tx) => {
        const existing = await tx
          .select()
          .from(issueWorkProducts)
          .where(eq(issueWorkProducts.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        await assertWorkProductMutationAllowed(tx as unknown as Db, existing.companyId, existing.issueId, actor);

        if (patch.isPrimary === true) {
          await tx
            .update(issueWorkProducts)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(issueWorkProducts.companyId, existing.companyId),
                eq(issueWorkProducts.issueId, existing.issueId),
                eq(issueWorkProducts.type, existing.type),
              ),
            );
        }

        return await tx
          .update(issueWorkProducts)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(issueWorkProducts.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
      });
      return row ? toIssueWorkProduct(row) : null;
    },

    remove: async (id: string, actor?: WorkProductActor) => {
      const row = await db.transaction(async (tx) => {
        const existing = await tx
          .select()
          .from(issueWorkProducts)
          .where(eq(issueWorkProducts.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        await assertWorkProductMutationAllowed(tx as unknown as Db, existing.companyId, existing.issueId, actor);

        return await tx
          .delete(issueWorkProducts)
          .where(eq(issueWorkProducts.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
      });
      return row ? toIssueWorkProduct(row) : null;
    },
  };
}

export { toIssueWorkProduct };
