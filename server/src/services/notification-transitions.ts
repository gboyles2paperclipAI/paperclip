import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { notificationTransitions } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

/**
 * Durable transition-keyed notification dedup
 * (ADR-20260823-quiescent-coordination R2.15).
 *
 * One `notification_transitions` row per (company, subject, event class)
 * records the last transition that was actually ACCEPTED by a notification
 * channel. The decision rule:
 *
 * - a missing or unreadable previous transition ALWAYS notifies
 *   (unknown != unchanged; never suppress on unknown);
 * - an unchanged {nextState, ownerIdentity} pair is suppressed;
 * - any state or owner change notifies exactly once;
 * - the row is only written after a channel accepted the message (API success
 *   plus a message id/ts), so a failed or unconfigured channel leaves the
 *   transition unacknowledged and retryable.
 */

export interface NotificationTransitionDescriptor {
  subject: string;
  eventClass: string;
  /** Canonical alert-relevant state for the subject (small, JSON-safe). */
  nextState: Record<string, unknown>;
  /** Identity responsible for acting on the alert; owner changes re-notify. */
  ownerIdentity: string | null;
}

export interface NotificationTransitionEvaluation {
  notify: boolean;
  /** False when no durable store is reachable for this event (no db/company). */
  recordable: boolean;
  reason: "no_store" | "no_previous" | "unreadable_previous" | "changed" | "unchanged";
  /** Full transition hash (includes previousState) when a notify is due. */
  stateHash: string | null;
  /** The previous notified state, when readable. */
  previousState: Record<string, unknown> | null;
}

interface StoredPreviousTransition {
  state: Record<string, unknown>;
  ownerIdentity: string | null;
}

/** Deterministic JSON with recursively sorted object keys. */
export function canonicalTransitionJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortValue(record[key])]),
    );
  }
  return value ?? null;
}

/**
 * sha256 over the canonical JSON tuple
 * `{subject, eventClass, previousState, nextState, ownerIdentity}` (R2.15).
 */
export function computeTransitionStateHash(input: {
  subject: string;
  eventClass: string;
  previousState: unknown;
  nextState: unknown;
  ownerIdentity: string | null;
}): string {
  return createHash("sha256")
    .update(
      canonicalTransitionJson({
        subject: input.subject,
        eventClass: input.eventClass,
        previousState: input.previousState ?? null,
        nextState: input.nextState ?? null,
        ownerIdentity: input.ownerIdentity ?? null,
      }),
    )
    .digest("hex");
}

function readStoredPrevious(value: unknown): StoredPreviousTransition | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const previous = (value as Record<string, unknown>)._previous;
  if (!previous || typeof previous !== "object" || Array.isArray(previous)) return null;
  const record = previous as Record<string, unknown>;
  const state = record.state;
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const ownerIdentity = typeof record.ownerIdentity === "string" ? record.ownerIdentity : null;
  return { state: state as Record<string, unknown>, ownerIdentity };
}

export async function evaluateNotificationTransition(
  db: Db | undefined,
  companyId: string | null | undefined,
  descriptor: NotificationTransitionDescriptor,
): Promise<NotificationTransitionEvaluation> {
  const hashFor = (previousState: unknown) =>
    computeTransitionStateHash({
      subject: descriptor.subject,
      eventClass: descriptor.eventClass,
      previousState,
      nextState: descriptor.nextState,
      ownerIdentity: descriptor.ownerIdentity ?? null,
    });

  if (!db || !companyId || !isUuidLike(companyId)) {
    // No durable store reachable: unknown previous state always notifies.
    return { notify: true, recordable: false, reason: "no_store", stateHash: hashFor(null), previousState: null };
  }

  let row: typeof notificationTransitions.$inferSelect | null = null;
  let readFailed = false;
  try {
    row = await db
      .select()
      .from(notificationTransitions)
      .where(
        and(
          eq(notificationTransitions.companyId, companyId),
          eq(notificationTransitions.subject, descriptor.subject),
          eq(notificationTransitions.eventClass, descriptor.eventClass),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
  } catch (err) {
    readFailed = true;
    logger.warn(
      { err, subject: descriptor.subject, eventClass: descriptor.eventClass },
      "notification transition read failed; treating previous state as unreadable (notify)",
    );
  }

  if (readFailed) {
    return { notify: true, recordable: true, reason: "unreadable_previous", stateHash: hashFor(null), previousState: null };
  }
  if (!row) {
    return { notify: true, recordable: true, reason: "no_previous", stateHash: hashFor(null), previousState: null };
  }

  const previous = readStoredPrevious(row.acknowledgedChannels);
  if (!previous) {
    // Row exists but its previous-state payload is unreadable: notify.
    return { notify: true, recordable: true, reason: "unreadable_previous", stateHash: hashFor(null), previousState: null };
  }

  const unchanged =
    canonicalTransitionJson(previous.state) === canonicalTransitionJson(descriptor.nextState)
    && (previous.ownerIdentity ?? null) === (descriptor.ownerIdentity ?? null);
  if (unchanged) {
    return { notify: false, recordable: true, reason: "unchanged", stateHash: null, previousState: previous.state };
  }
  return {
    notify: true,
    recordable: true,
    reason: "changed",
    stateHash: hashFor(previous.state),
    previousState: previous.state,
  };
}

export interface AcceptedChannelReceipt {
  channel: string;
  messageId: string;
  acceptedAt: string;
}

/**
 * Record a notified transition AFTER at least one channel accepted it.
 * Callers must NOT invoke this when every channel failed or was unset — the
 * absent/unchanged row is what makes the transition retryable.
 */
export async function recordNotificationTransition(
  db: Db,
  input: {
    companyId: string;
    subject: string;
    eventClass: string;
    stateHash: string;
    nextState: Record<string, unknown>;
    ownerIdentity: string | null;
    acceptedChannels: Record<string, AcceptedChannelReceipt>;
  },
): Promise<void> {
  const now = new Date();
  const acknowledgedChannels = {
    _previous: {
      state: input.nextState,
      ownerIdentity: input.ownerIdentity ?? null,
    },
    channels: input.acceptedChannels,
  };
  await db
    .insert(notificationTransitions)
    .values({
      companyId: input.companyId,
      subject: input.subject,
      eventClass: input.eventClass,
      stateHash: input.stateHash,
      lastNotifiedAt: now,
      notifyCount: 1,
      acknowledgedChannels,
    })
    .onConflictDoUpdate({
      target: [
        notificationTransitions.companyId,
        notificationTransitions.subject,
        notificationTransitions.eventClass,
      ],
      set: {
        stateHash: input.stateHash,
        lastNotifiedAt: now,
        notifyCount: sql`${notificationTransitions.notifyCount} + 1`,
        acknowledgedChannels,
      },
    });
}
