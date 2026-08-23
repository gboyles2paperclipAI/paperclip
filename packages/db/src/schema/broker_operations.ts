import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { approvals } from "./approvals.js";
import { companies } from "./companies.js";

export const brokerOperations = pgTable(
  "broker_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    args: jsonb("args").$type<Record<string, unknown>>().notNull(),
    approvalId: uuid("approval_id").notNull().references(() => approvals.id),
    idempotencyKey: text("idempotency_key").notNull(),
    state: text("state").notNull().default("enqueued"),
    claimGeneration: integer("claim_generation").notNull().default(0),
    claimHeartbeatAt: timestamp("claim_heartbeat_at", { withTimezone: true }),
    claimedBy: text("claimed_by"),
    preflight: jsonb("preflight").$type<Record<string, unknown>>(),
    receipt: jsonb("receipt").$type<Record<string, unknown>>(),
    rollbackState: jsonb("rollback_state").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdemUq: uniqueIndex("broker_operations_company_idem_uq").on(table.companyId, table.idempotencyKey),
  }),
);
