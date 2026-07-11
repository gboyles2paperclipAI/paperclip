import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";

export type MatchingAgentRun = {
  id: string;
  companyId: string;
  agentId: string;
  contextSnapshot: unknown;
};

/**
 * Resolve a run only when its persisted ownership matches the authenticated
 * agent and company. Callers must treat null as untrusted run context.
 */
export async function loadMatchingAgentRun(
  db: Db,
  input: { runId: string | null | undefined; companyId: string; agentId: string },
): Promise<MatchingAgentRun | null> {
  if (!input.runId || !isUuidLike(input.runId)) return null;

  const row = await db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      contextSnapshot: heartbeatRuns.contextSnapshot,
    })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, input.runId))
    .then((rows) => rows[0] ?? null);

  if (!row || row.companyId !== input.companyId || row.agentId !== input.agentId) return null;
  return row;
}
