import { z } from "zod";

/**
 * Opt-in decision-lease block accepted by approval-create and lease-capable
 * interaction-create requests (ADR-20260823-quiescent-coordination R2.11,
 * R3.2). `idempotencyKey` is the decision identity
 * (`decision:{issueId}:{purpose-slug}:{subjectRevision}` by convention) and is
 * MANDATORY for lease-creating decisions; `posture` is the waiting posture the
 * server writes in the same transaction as the lease (issue status + evidence
 * comment), so the owner never needs a follow-up write that its own freeze
 * would reject.
 */
export const decisionLeaseRequestSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(255),
  posture: z.object({
    status: z.literal("in_review"),
    comment: z.string().trim().min(1).max(20000),
  }),
});

export type DecisionLeaseRequest = z.infer<typeof decisionLeaseRequestSchema>;
