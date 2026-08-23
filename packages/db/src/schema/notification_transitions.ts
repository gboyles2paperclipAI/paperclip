import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Transition-keyed notification dedup ledger (ADR-20260823-quiescent-coordination
 * R2.15). One row per (company, subject, event class); `state_hash` is the
 * canonical hash of the last notified transition so an unchanged state never
 * re-notifies while a changed one always does. Written by the notification
 * contract in a later PR — PR-1 ships only the table.
 */
export const notificationTransitions = pgTable(
  "notification_transitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    subject: text("subject").notNull(),
    eventClass: text("event_class").notNull(),
    stateHash: text("state_hash").notNull(),
    lastNotifiedAt: timestamp("last_notified_at", { withTimezone: true }).notNull().defaultNow(),
    notifyCount: integer("notify_count").notNull().default(1),
    acknowledgedChannels: jsonb("acknowledged_channels").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySubjectEventUq: uniqueIndex("notification_transitions_company_subject_event_uq").on(
      table.companyId,
      table.subject,
      table.eventClass,
    ),
  }),
);
