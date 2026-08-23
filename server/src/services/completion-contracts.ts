import { createHash } from "node:crypto";
import { z } from "zod";
import { unprocessable } from "../errors.js";

/**
 * Completion contracts (ADR-20260823-quiescent-coordination R2.12/R2.13/R3.7,
 * PR-3).
 *
 * A completion contract is a preimage-bound, versioned obligation attached to
 * an issue: the issue may only transition to `done` once an accepted receipt
 * proves the contracted operation happened against EXACTLY the resources the
 * contract named when it was attached. The preimage (exact paths, content
 * hashes, baseline counts, identity requirements) is captured at attach time
 * and hashed; a receipt must reference that exact hash, so supersets, globs,
 * and post-hoc resource lists can never satisfy it (the FUL-20271 failure
 * shape: "quarantine file A" satisfied by moving 1,340 unrelated files).
 *
 * Enforcement lives at the single terminal-status chokepoint,
 * `issueService.update` (R2.13); this module owns the schemas and the
 * fail-closed receipt validation. `cancelled` is never gated by a contract.
 */

export const COMPLETION_CONTRACT_RECEIPT_RULE = "Completion contract requires an accepted receipt";
export const RESOLUTION_DISPOSITION_RULE =
  "Resolution disposition is recorded by the server on terminal transitions";

export const COMPLETION_CONTRACT_TYPES = [
  "exact_file_quarantine",
  "packaged_runtime_activation",
] as const;
export type CompletionContractType = (typeof COMPLETION_CONTRACT_TYPES)[number];

const sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "must be a lowercase sha256 hex digest");

/**
 * Preimage captured at attach time for a broker-executed exact-file
 * quarantine. `sourceDirEntryBaselineCount` is the TOTAL entry count of the
 * source directory at attach time, including the source file itself; the
 * accepted post-state is exactly `baseline - 1` remaining entries (only the
 * contracted file left the directory — the "unrelated file count unchanged"
 * invariant).
 */
const exactFileQuarantinePreimageSchema = z.object({
  sourcePath: z.string().min(1),
  sourceContentSha256: sha256HexSchema,
  quarantineTargetPath: z.string().min(1),
  sourceDirEntryBaselineCount: z.number().int().nonnegative(),
  /** Identity required to have performed the move (the broker). */
  executorIdentity: z.string().min(1),
  /** Reviewer identity must differ from executor and receipt submitter. */
  reviewerRequired: z.literal(true),
  rollbackArchiveRequired: z.boolean(),
}).strict();

/** Preimage captured at attach time for a packaged-runtime activation. */
const packagedRuntimeActivationPreimageSchema = z.object({
  candidateRootPath: z.string().min(1),
  /** Exact tarball/prefix content hashes of the candidate build. */
  artifactSha256s: z.array(sha256HexSchema).min(1),
  expectedVersion: z.string().min(1),
  expectedBuildCommit: z.string().min(1).nullable(),
  installerIdentity: z.string().min(1),
  rollbackArchiveRequired: z.literal(true),
}).strict();

const contractRevisionSchema = z.number().int().min(1);

const contractBaseShape = {
  version: z.literal(1),
  contractRevision: contractRevisionSchema,
  /** Stamped by the server at attach time; recomputed on every validation. */
  preimageSha256: sha256HexSchema.optional(),
  attachedAt: z.string().optional(),
  attachedBy: z.string().min(1).optional(),
} as const;

export const completionContractSchema = z.discriminatedUnion("contractType", [
  z.object({
    contractType: z.literal("exact_file_quarantine"),
    ...contractBaseShape,
    preimage: exactFileQuarantinePreimageSchema,
  }).strict(),
  z.object({
    contractType: z.literal("packaged_runtime_activation"),
    ...contractBaseShape,
    preimage: packagedRuntimeActivationPreimageSchema,
  }).strict(),
]);
export type CompletionContract = z.infer<typeof completionContractSchema>;

const rollbackEvidenceSchema = z.object({
  archivePath: z.string().min(1),
  archiveSha256: sha256HexSchema,
}).strict();

/**
 * Acceptance stamp added by the server when a receipt is accepted. The
 * optional `disposition` lets a server-side acceptance path (never a client)
 * carry the resolution disposition the terminal transition should record
 * (Gemini C4: disposition propagation).
 */
const receiptAcceptanceSchema = z.object({
  issueId: z.string().min(1),
  executionRunId: z.string().min(1),
  contractRevision: contractRevisionSchema,
  acceptedAt: z.string().min(1),
  disposition: z.enum(["completed", "superseded", "failed"]).optional(),
}).strict();
export type CompletionReceiptAcceptance = z.infer<typeof receiptAcceptanceSchema>;

/**
 * Strip every underscore-prefixed key (`_acceptance` above all) from a
 * client-supplied completion receipt BEFORE it is shape-checked or stored.
 * Server code is the only writer of `_acceptance`: it is stamped exclusively
 * after `validateCompletionReceipt` accepts (here or on the broker forward
 * path), so a stamp arriving from a route/plugin/MCP payload is always a
 * forgery attempt — silently dropped, never honored (stack-review blocker A).
 */
export function stripClientCompletionReceiptFields(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([key]) => !key.startsWith("_")),
  );
}

const receiptBaseShape = {
  version: z.literal(1),
  contractRevision: contractRevisionSchema,
  /** Must equal the recomputed hash of the attached contract's preimage. */
  preimageSha256: sha256HexSchema,
  /** The execution this receipt is bound to (broker operation/run id). */
  executionRunId: z.string().min(1),
  executorIdentity: z.string().min(1),
  reviewerIdentity: z.string().min(1).optional(),
  submittedBy: z.string().min(1).optional(),
  rollbackEvidence: rollbackEvidenceSchema.nullable().optional(),
  _acceptance: receiptAcceptanceSchema.optional(),
} as const;

const exactFileQuarantineReceiptSchema = z.object({
  contractType: z.literal("exact_file_quarantine"),
  ...receiptBaseShape,
  assertions: z.object({
    sourceAbsentFromSourceDir: z.boolean(),
    targetPresentWithMatchingHash: z.boolean(),
    observedTargetContentSha256: sha256HexSchema,
    observedSourceDirEntryCount: z.number().int().nonnegative(),
    /** The exact set of entries that left the source directory. */
    movedEntryPaths: z.array(z.string().min(1)).min(1),
  }).strict(),
}).strict();

const packagedRuntimeActivationReceiptSchema = z.object({
  contractType: z.literal("packaged_runtime_activation"),
  ...receiptBaseShape,
  assertions: z.object({
    activatedVersion: z.string().min(1),
    activatedBuildCommit: z.string().min(1).nullable(),
    verifiedArtifactSha256s: z.array(sha256HexSchema).min(1),
    healthVerified: z.boolean(),
  }).strict(),
}).strict();

export const completionReceiptSchema = z.discriminatedUnion("contractType", [
  exactFileQuarantineReceiptSchema,
  packagedRuntimeActivationReceiptSchema,
]);
export type CompletionReceipt = z.infer<typeof completionReceiptSchema>;

/** Canonical JSON: recursively key-sorted objects, `undefined` keys dropped. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(",")}}`;
}

/**
 * The preimage binding hash: contract type + schema version + the full
 * preimage, canonically serialized. Contract revision is deliberately NOT part
 * of the hash — revisions are compared explicitly so a stale receipt is
 * reported as stale rather than as a hash mismatch.
 */
export function computeCompletionContractPreimageSha256(contract: {
  contractType: CompletionContractType;
  version: number;
  preimage: Record<string, unknown>;
}): string {
  return createHash("sha256")
    .update(canonicalJson({
      contractType: contract.contractType,
      version: contract.version,
      preimage: contract.preimage,
    }))
    .digest("hex");
}

function contractValidationDetails(issues: z.ZodIssue[]) {
  return issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

/**
 * Parse + preimage-bind a contract at attach time (issue create/update by
 * board/system actors, or the broker path). Fails 422 on any structural
 * problem; stamps `preimageSha256` (and rejects a caller-provided stamp that
 * does not match the preimage, so a mutated contract cannot keep an old
 * binding).
 */
export function normalizeCompletionContractOnAttach(
  value: unknown,
  options: { attachedBy?: string | null } = {},
): Record<string, unknown> {
  const parsed = completionContractSchema.safeParse(value);
  if (!parsed.success) {
    throw unprocessable("Completion contract is not a valid typed contract", {
      rule: COMPLETION_CONTRACT_RECEIPT_RULE,
      reasons: ["contract_unparseable"],
      validation: contractValidationDetails(parsed.error.issues),
    });
  }
  const contract = parsed.data;
  const computed = computeCompletionContractPreimageSha256(contract);
  if (contract.preimageSha256 !== undefined && contract.preimageSha256 !== computed) {
    throw unprocessable("Completion contract preimageSha256 does not match its preimage", {
      rule: COMPLETION_CONTRACT_RECEIPT_RULE,
      reasons: ["contract_preimage_binding_broken"],
    });
  }
  return {
    ...contract,
    preimageSha256: computed,
    attachedAt: contract.attachedAt ?? new Date().toISOString(),
    ...(contract.attachedBy === undefined && options.attachedBy
      ? { attachedBy: options.attachedBy }
      : {}),
  };
}

/** Structural fail-fast parse for a receipt submitted ahead of the done gate. */
export function assertCompletionReceiptShape(value: unknown): void {
  const parsed = completionReceiptSchema.safeParse(value);
  if (!parsed.success) {
    throw unprocessable("Completion receipt is not a valid typed receipt", {
      rule: COMPLETION_CONTRACT_RECEIPT_RULE,
      reasons: ["receipt_unparseable"],
      validation: contractValidationDetails(parsed.error.issues),
    });
  }
}

/** Extract the server acceptance stamp from a stored receipt, if any. */
export function getCompletionReceiptAcceptance(value: unknown): CompletionReceiptAcceptance | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const acceptance = (value as Record<string, unknown>)._acceptance;
  const parsed = receiptAcceptanceSchema.safeParse(acceptance);
  return parsed.success ? parsed.data : null;
}

export type CompletionReceiptVerdict =
  | { outcome: "accepted"; acceptedReceipt: Record<string, unknown> }
  /** Resubmit of the already-accepted receipt: no-op success, stored receipt kept. */
  | { outcome: "idempotent_replay"; acceptedReceipt: Record<string, unknown> }
  | { outcome: "rejected"; reasons: string[] };

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const entry of setA) if (!setB.has(entry)) return false;
  return true;
}

/**
 * Fail-closed receipt validation (R2.12).
 *
 * Rejects on: unparseable contract/receipt, contract-type mismatch, stale
 * contract revision, wrong execution id, changed/mismatched preimage hash,
 * false assertions, superset resource sets, reviewer==executor or
 * reviewer==submitter, and missing rollback evidence.
 *
 * Accepted-receipt idempotency key is `(issueId, executionId,
 * contractRevision)`: a resubmit of the already-accepted receipt is a no-op
 * success; a receipt bound to a DIFFERENT execution against an
 * already-satisfied contract is rejected (an old accepted receipt can never
 * close a later execution, and a later execution can never displace an
 * accepted receipt).
 */
export function validateCompletionReceipt(
  contractValue: unknown,
  receiptValue: unknown,
  context: {
    issueId: string;
    /** The execution the issue is bound to, when one is stamped. */
    expectedExecutionRunId?: string | null;
    /** Actor recording the receipt, used when the receipt has no submittedBy. */
    submitterIdentity?: string | null;
    /** The stored, previously accepted receipt for this issue, if any. */
    previouslyAcceptedReceipt?: unknown;
  },
): CompletionReceiptVerdict {
  const parsedContract = completionContractSchema.safeParse(contractValue);
  if (!parsedContract.success) {
    return { outcome: "rejected", reasons: ["contract_unparseable"] };
  }
  const contract = parsedContract.data;

  if (receiptValue == null) {
    return { outcome: "rejected", reasons: ["receipt_missing"] };
  }
  const parsedReceipt = completionReceiptSchema.safeParse(receiptValue);
  if (!parsedReceipt.success) {
    return { outcome: "rejected", reasons: ["receipt_unparseable"] };
  }
  const receipt = parsedReceipt.data;

  // Idempotency against the already-accepted receipt, if one exists.
  const priorAcceptance = getCompletionReceiptAcceptance(context.previouslyAcceptedReceipt);
  if (priorAcceptance && priorAcceptance.issueId === context.issueId) {
    if (
      receipt.executionRunId === priorAcceptance.executionRunId &&
      receipt.contractRevision === priorAcceptance.contractRevision &&
      contract.contractRevision === priorAcceptance.contractRevision
    ) {
      return {
        outcome: "idempotent_replay",
        acceptedReceipt: context.previouslyAcceptedReceipt as Record<string, unknown>,
      };
    }
    return { outcome: "rejected", reasons: ["contract_already_satisfied_by_different_execution"] };
  }

  const reasons: string[] = [];

  if (receipt.contractType !== contract.contractType) {
    reasons.push("contract_type_mismatch");
  }
  if (receipt.contractRevision !== contract.contractRevision) {
    reasons.push("stale_contract_revision");
  }
  if (
    context.expectedExecutionRunId != null &&
    receipt.executionRunId !== context.expectedExecutionRunId
  ) {
    reasons.push("wrong_execution_id");
  }

  const computedPreimageSha256 = computeCompletionContractPreimageSha256(contract);
  if (contract.preimageSha256 !== undefined && contract.preimageSha256 !== computedPreimageSha256) {
    reasons.push("contract_preimage_binding_broken");
  }
  if (receipt.preimageSha256 !== computedPreimageSha256) {
    reasons.push("preimage_hash_mismatch");
  }

  const requiredExecutorIdentity = contract.contractType === "exact_file_quarantine"
    ? contract.preimage.executorIdentity
    : contract.preimage.installerIdentity;
  if (receipt.executorIdentity !== requiredExecutorIdentity) {
    reasons.push("executor_identity_mismatch");
  }

  const submitterIdentity = receipt.submittedBy ?? context.submitterIdentity ?? null;
  const reviewerRequired = contract.contractType === "exact_file_quarantine"
    ? contract.preimage.reviewerRequired
    : false;
  if (reviewerRequired && !receipt.reviewerIdentity) {
    reasons.push("missing_reviewer");
  }
  if (receipt.reviewerIdentity) {
    if (receipt.reviewerIdentity === receipt.executorIdentity) {
      reasons.push("reviewer_is_executor");
    }
    if (submitterIdentity != null && receipt.reviewerIdentity === submitterIdentity) {
      reasons.push("reviewer_is_receipt_submitter");
    }
  }

  const rollbackRequired = contract.preimage.rollbackArchiveRequired;
  if (rollbackRequired && !receipt.rollbackEvidence) {
    reasons.push("missing_rollback_evidence");
  }

  if (contract.contractType === "exact_file_quarantine" && receipt.contractType === "exact_file_quarantine") {
    const { preimage } = contract;
    const { assertions } = receipt;
    if (!assertions.sourceAbsentFromSourceDir) {
      reasons.push("source_file_still_present");
    }
    if (!assertions.targetPresentWithMatchingHash) {
      reasons.push("target_missing_or_hash_mismatch");
    }
    if (assertions.observedTargetContentSha256 !== preimage.sourceContentSha256) {
      reasons.push("source_content_hash_changed");
    }
    if (assertions.observedSourceDirEntryCount !== preimage.sourceDirEntryBaselineCount - 1) {
      reasons.push("unrelated_entry_count_changed");
    }
    if (!sameStringSet(assertions.movedEntryPaths, [preimage.sourcePath])) {
      reasons.push("resource_set_exceeds_preimage");
    }
    if (receipt.rollbackEvidence && receipt.rollbackEvidence.archiveSha256 !== preimage.sourceContentSha256) {
      reasons.push("rollback_evidence_hash_mismatch");
    }
  }

  if (
    contract.contractType === "packaged_runtime_activation" &&
    receipt.contractType === "packaged_runtime_activation"
  ) {
    const { preimage } = contract;
    const { assertions } = receipt;
    if (!assertions.healthVerified) {
      reasons.push("health_not_verified");
    }
    if (assertions.activatedVersion !== preimage.expectedVersion) {
      reasons.push("activated_version_mismatch");
    }
    if (
      preimage.expectedBuildCommit != null &&
      assertions.activatedBuildCommit !== preimage.expectedBuildCommit
    ) {
      reasons.push("build_commit_mismatch");
    }
    if (!sameStringSet(assertions.verifiedArtifactSha256s, preimage.artifactSha256s)) {
      reasons.push("artifact_hash_set_mismatch");
    }
  }

  if (reasons.length > 0) {
    return { outcome: "rejected", reasons };
  }

  const acceptedReceipt: Record<string, unknown> = {
    ...receipt,
    ...(receipt.submittedBy === undefined && submitterIdentity != null
      ? { submittedBy: submitterIdentity }
      : {}),
    _acceptance: {
      issueId: context.issueId,
      executionRunId: receipt.executionRunId,
      contractRevision: receipt.contractRevision,
      acceptedAt: new Date().toISOString(),
    } satisfies CompletionReceiptAcceptance,
  };
  return { outcome: "accepted", acceptedReceipt };
}
