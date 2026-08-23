import { z } from "zod";
import { APPROVAL_TYPES } from "../constants.js";
import { brokerOperationRequestSchema } from "./broker-operation.js";
import { decisionLeaseRequestSchema } from "./decision-lease.js";
import { multilineTextSchema } from "./text.js";

export const createApprovalSchema = z.object({
  type: z.enum(APPROVAL_TYPES),
  requestedByAgentId: z.string().uuid().optional().nullable(),
  payload: z.record(z.string(), z.unknown()),
  issueIds: z.array(z.string().uuid()).optional(),
  // Decision idempotency (R2.11): equivalent replays return the existing open
  // approval; same key + different payload conflicts.
  idempotencyKey: z.string().trim().min(1).max(255).nullable().optional(),
  // Explicit opt-in quiescent-wait lease (R3.2). Requires at least one linked
  // issue; the first linked issue is the lease anchor.
  decisionLease: decisionLeaseRequestSchema.nullable().optional(),
  // Approved-action broker request (R2.16/PR-5): the typed operation + content
  // hashes are bound into the approval payload at create time; NOTHING is
  // enqueued until the approval is accepted. Requires a decisionLease block
  // (broker operations are lease-bound in v1).
  brokerOperation: brokerOperationRequestSchema.nullable().optional(),
});

export type CreateApproval = z.infer<typeof createApprovalSchema>;

export const resolveApprovalSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
});

export type ResolveApproval = z.infer<typeof resolveApprovalSchema>;

export const requestApprovalRevisionSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
});

export type RequestApprovalRevision = z.infer<typeof requestApprovalRevisionSchema>;

export const resubmitApprovalSchema = z.object({
  payload: z.record(z.string(), z.unknown()).optional(),
});

export type ResubmitApproval = z.infer<typeof resubmitApprovalSchema>;

export const addApprovalCommentSchema = z.object({
  body: multilineTextSchema.pipe(z.string().min(1)),
});

export type AddApprovalComment = z.infer<typeof addApprovalCommentSchema>;
