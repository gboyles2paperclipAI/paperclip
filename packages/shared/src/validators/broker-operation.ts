import { z } from "zod";

/**
 * Approved-action broker operations (ADR-20260823-quiescent-coordination
 * R2.16, R3.6, R3.7 — PR-5).
 *
 * v1 ships exactly two named operations. A broker-operation REQUEST rides an
 * approval create (next to the `decisionLease` block); nothing is enqueued at
 * request time. On approval acceptance the server enqueues a
 * `broker_operations` row exactly once; the host broker claims it with a
 * generation-fenced CAS and reports a receipt validated against the PR-3
 * completion contract attached to every linked issue.
 *
 * Evidence hygiene: every field is an id, exact path, hash, count, or boolean.
 * Free text is limited to the single bounded `note` field; all objects are
 * `.strict()` so undeclared fields are rejected.
 */

const sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "must be a lowercase sha256 hex digest");

const absolutePathSchema = z
  .string()
  .min(2)
  .max(1024)
  .regex(/^\//, "must be an absolute path");

/** Claimer/executor identities are id-shaped, never prose. */
const brokerIdentitySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/, "must be an id-shaped identity");

/** The one bounded free-text field allowed anywhere in broker evidence. */
const boundedNoteSchema = z.string().trim().min(1).max(500);

export const BROKER_OPERATION_NAMES = [
  "activate_runtime_candidate",
  "quarantine_exact_file",
] as const;
export type BrokerOperationName = (typeof BROKER_OPERATION_NAMES)[number];

/**
 * Content hashes are captured at request time and bound into the approval
 * payload; the broker re-verifies them immediately before execution (R2.16).
 */
export const activateRuntimeCandidateArgsSchema = z.object({
  candidateRootPath: absolutePathSchema,
  /** Exact prefix/tarball content hashes of the candidate build. */
  artifactSha256s: z.array(sha256HexSchema).min(1).max(64),
  expectedVersion: z.string().trim().min(1).max(128),
  expectedBuildCommit: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/, "must be a git commit hash")
    .nullable(),
}).strict();
export type ActivateRuntimeCandidateArgs = z.infer<typeof activateRuntimeCandidateArgsSchema>;

export const quarantineExactFileArgsSchema = z.object({
  sourcePath: absolutePathSchema,
  sourceContentSha256: sha256HexSchema,
  quarantineTargetPath: absolutePathSchema,
  /** Total source-directory entry count at request time (FUL-20271 guard). */
  sourceDirEntryBaselineCount: z.number().int().nonnegative().max(10_000_000),
}).strict();
export type QuarantineExactFileArgs = z.infer<typeof quarantineExactFileArgsSchema>;

/** The request block that rides `POST /approvals` next to `decisionLease`. */
export const brokerOperationRequestSchema = z.discriminatedUnion("name", [
  z.object({
    name: z.literal("activate_runtime_candidate"),
    args: activateRuntimeCandidateArgsSchema,
    note: boundedNoteSchema.optional(),
  }).strict(),
  z.object({
    name: z.literal("quarantine_exact_file"),
    args: quarantineExactFileArgsSchema,
    note: boundedNoteSchema.optional(),
  }).strict(),
]);
export type BrokerOperationRequest = z.infer<typeof brokerOperationRequestSchema>;

export const claimBrokerOperationSchema = z.object({
  claimedBy: brokerIdentitySchema,
  /** CAS fence (R3.6): must equal the row's current claim_generation. */
  expectedGeneration: z.number().int().nonnegative(),
}).strict();
export type ClaimBrokerOperation = z.infer<typeof claimBrokerOperationSchema>;

export const heartbeatBrokerOperationSchema = z.object({
  claimedBy: brokerIdentitySchema,
  claimGeneration: z.number().int().positive(),
}).strict();
export type HeartbeatBrokerOperation = z.infer<typeof heartbeatBrokerOperationSchema>;

/** Preflight evidence: booleans, hashes, and counts only (R2.16 re-hash). */
export const brokerPreflightReportSchema = z.object({
  hashesVerified: z.boolean(),
  observedSha256s: z.array(sha256HexSchema).max(64).optional(),
  mismatchCount: z.number().int().nonnegative().optional(),
  note: boundedNoteSchema.optional(),
}).strict();
export type BrokerPreflightReport = z.infer<typeof brokerPreflightReportSchema>;

const brokerRollbackEvidenceSchema = z.object({
  archivePath: absolutePathSchema,
  archiveSha256: sha256HexSchema,
}).strict();
export type BrokerRollbackEvidence = z.infer<typeof brokerRollbackEvidenceSchema>;

/**
 * Receipt submission. `completionReceipt` is the PR-3 typed completion
 * receipt; the server validates it against each linked issue's attached
 * contract (strictly typed there), so it is passed through structurally here.
 * A succeeded outcome requires it; a failed outcome must not carry one.
 */
export const submitBrokerOperationReceiptSchema = z.object({
  claimedBy: brokerIdentitySchema,
  claimGeneration: z.number().int().positive(),
  outcome: z.enum(["succeeded", "failed"]),
  completionReceipt: z.record(z.string(), z.unknown()).optional(),
  preflight: brokerPreflightReportSchema.optional(),
  rollbackEvidence: brokerRollbackEvidenceSchema.optional(),
  note: boundedNoteSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.outcome === "succeeded" && value.completionReceipt === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["completionReceipt"],
      message: "a succeeded receipt requires the typed completionReceipt",
    });
  }
  if (value.outcome === "failed" && value.completionReceipt !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["completionReceipt"],
      message: "a failed receipt must not carry a completionReceipt",
    });
  }
  if (value.outcome === "succeeded" && value.rollbackEvidence !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["rollbackEvidence"],
      message: "rollback evidence belongs on a failed receipt",
    });
  }
});
export type SubmitBrokerOperationReceipt = z.infer<typeof submitBrokerOperationReceiptSchema>;
