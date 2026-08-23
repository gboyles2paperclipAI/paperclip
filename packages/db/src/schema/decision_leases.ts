import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const decisionLeases = pgTable(
  "decision_leases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    decisionKind: text("decision_kind").notNull(),
    decisionId: uuid("decision_id").notNull(),
    decisionIdempotencyKey: text("decision_idempotency_key").notNull(),
    anchorIssueId: uuid("anchor_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    state: text("state").notNull().default("active"),
    disposition: text("disposition"),
    slaConfig: jsonb("sla_config").$type<Record<string, unknown>>(),
    lastReminderStateHash: text("last_reminder_state_hash"),
    lastReminderAt: timestamp("last_reminder_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (table) => ({
    companyActiveIdemUq: uniqueIndex("decision_leases_company_active_idem_uq")
      .on(table.companyId, table.decisionIdempotencyKey)
      .where(sql`${table.state} in ('active', 'revising')`),
    companyStateIdx: index("decision_leases_company_state_idx").on(table.companyId, table.state),
  }),
);

export const decisionLeaseMembers = pgTable(
  "decision_lease_members",
  {
    leaseId: uuid("lease_id").notNull().references(() => decisionLeases.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.leaseId, table.issueId] }),
    issueIdx: index("decision_lease_members_issue_idx").on(table.issueId),
  }),
);

export const decisionContinuations = pgTable(
  "decision_continuations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leaseId: uuid("lease_id").notNull().references(() => decisionLeases.id, { onDelete: "cascade" }),
    disposition: text("disposition").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    deliveryAttempts: integer("delivery_attempts").notNull().default(0),
    deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
  },
  (table) => ({
    leaseUq: uniqueIndex("decision_continuations_lease_uq").on(table.leaseId),
  }),
);
