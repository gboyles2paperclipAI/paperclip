import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { instanceUserRoles } from "@paperclipai/db";

/** Sentinel user id for the pre-claim local_trusted board principal. */
export const LOCAL_BOARD_USER_ID = "local-board";

/**
 * Shared serialization point for local-board credential retirement and
 * single-winner board claim.
 *
 * Board claim, local-board CLI approval, and local-board named board-key mint
 * all lock this row (when present) before either minting a new local-board
 * board API key or revoking/demoting residual local-board access.
 * Under READ COMMITTED:
 * - if a mint path holds the lock first, claim later revokes any key it mints;
 * - if claim holds/commits first, waiting mint paths see no admin row and
 *   must refuse new local-board key issuance;
 * - if a second claim waits on the same lock and the first claim commits
 *   (deleting this row), the second claim must abort with zero side effects
 *   (no claimant admin/membership/grants/audit).
 *
 * Missing row: no row lock is taken (Postgres SELECT FOR UPDATE on empty set).
 * Callers must treat null as "already retired / already claimed" and must not
 * promote or mint based on a missing row.
 */
export async function lockLocalBoardInstanceAdminForUpdate(
  tx: Db,
): Promise<{ id: string } | null> {
  return tx
    .select({ id: instanceUserRoles.id })
    .from(instanceUserRoles)
    .where(
      and(
        eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID),
        eq(instanceUserRoles.role, "instance_admin"),
      ),
    )
    .for("update")
    .then((rows) => rows[0] ?? null);
}
