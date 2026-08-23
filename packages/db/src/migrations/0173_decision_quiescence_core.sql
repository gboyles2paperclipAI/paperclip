CREATE TABLE IF NOT EXISTS "decision_leases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "decision_kind" text NOT NULL,
  "decision_id" uuid NOT NULL,
  "decision_idempotency_key" text NOT NULL,
  "anchor_issue_id" uuid NOT NULL,
  "state" text DEFAULT 'active' NOT NULL,
  "disposition" text,
  "sla_config" jsonb,
  "last_reminder_state_hash" text,
  "last_reminder_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "released_at" timestamp with time zone
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "decision_leases" ADD CONSTRAINT "decision_leases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "decision_leases" ADD CONSTRAINT "decision_leases_anchor_issue_id_issues_id_fk" FOREIGN KEY ("anchor_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "decision_leases_company_active_idem_uq" ON "decision_leases" USING btree ("company_id","decision_idempotency_key") WHERE "decision_leases"."state" in ('active', 'revising');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decision_leases_company_state_idx" ON "decision_leases" USING btree ("company_id","state");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "decision_lease_members" (
  "lease_id" uuid NOT NULL,
  "issue_id" uuid NOT NULL,
  "added_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "decision_lease_members_lease_id_issue_id_pk" PRIMARY KEY ("lease_id", "issue_id")
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "decision_lease_members" ADD CONSTRAINT "decision_lease_members_lease_id_decision_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."decision_leases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "decision_lease_members" ADD CONSTRAINT "decision_lease_members_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decision_lease_members_issue_idx" ON "decision_lease_members" USING btree ("issue_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "decision_continuations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "lease_id" uuid NOT NULL,
  "disposition" text NOT NULL,
  "payload" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "consumed_at" timestamp with time zone,
  "delivery_attempts" integer DEFAULT 0 NOT NULL,
  "dead_lettered_at" timestamp with time zone
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "decision_continuations" ADD CONSTRAINT "decision_continuations_lease_id_decision_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."decision_leases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "decision_continuations_lease_uq" ON "decision_continuations" USING btree ("lease_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "broker_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "name" text NOT NULL,
  "args" jsonb NOT NULL,
  "approval_id" uuid NOT NULL,
  "idempotency_key" text NOT NULL,
  "state" text DEFAULT 'enqueued' NOT NULL,
  "claim_generation" integer DEFAULT 0 NOT NULL,
  "claim_heartbeat_at" timestamp with time zone,
  "claimed_by" text,
  "preflight" jsonb,
  "receipt" jsonb,
  "rollback_state" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "broker_operations" ADD CONSTRAINT "broker_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "broker_operations" ADD CONSTRAINT "broker_operations_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "broker_operations_company_idem_uq" ON "broker_operations" USING btree ("company_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "approvals_company_open_idem_uq" ON "approvals" USING btree ("company_id","idempotency_key") WHERE "approvals"."idempotency_key" is not null
          and "approvals"."status" in ('pending', 'revision_requested');--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "tracking_mode" text DEFAULT 'issue_always' NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "completion_contract" jsonb;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "completion_receipt" jsonb;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "resolution_disposition" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issues_open_routine_execution_hidden_uq" ON "issues" USING btree ("company_id","origin_kind","origin_id","origin_fingerprint") WHERE "issues"."origin_kind" = 'routine_execution'
          and "issues"."origin_id" is not null
          and "issues"."hidden_at" is not null
          and "issues"."execution_run_id" is not null
          and "issues"."status" in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issues_open_routine_failure_episode_uq" ON "issues" USING btree ("company_id","origin_kind","origin_id") WHERE "issues"."origin_kind" = 'routine_failure_episode'
          and "issues"."origin_id" is not null
          and "issues"."hidden_at" is null
          and "issues"."status" in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked');--> statement-breakpoint
UPDATE "agent_wakeup_requests" AS awr
SET "status" = 'cancelled',
    "finished_at" = now(),
    "error" = 'Cancelled by migration 0173: duplicate pending wakeup request for the same idempotency key',
    "updated_at" = now()
FROM (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "idempotency_key"
      ORDER BY "requested_at" ASC, "created_at" ASC, "id" ASC
    ) AS "duplicate_rank"
  FROM "agent_wakeup_requests"
  WHERE "idempotency_key" IS NOT NULL
    AND "status" IN ('queued', 'claimed', 'deferred_issue_execution')
) AS "ranked"
WHERE awr."id" = "ranked"."id"
  AND "ranked"."duplicate_rank" > 1;--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: partial index over the small pending-status subset; the migration runner applies migrations inside a transaction where CREATE INDEX CONCURRENTLY is not allowed
CREATE UNIQUE INDEX IF NOT EXISTS "agent_wakeup_requests_pending_idem_uq" ON "agent_wakeup_requests" USING btree ("idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" is not null
          and "agent_wakeup_requests"."status" in ('queued', 'claimed', 'deferred_issue_execution');--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: partial expression index over the small pending-status subset (decision-lease drain by payload issueId); the migration runner applies migrations inside a transaction where CREATE INDEX CONCURRENTLY is not allowed
CREATE INDEX IF NOT EXISTS "agent_wakeup_requests_pending_payload_issue_idx" ON "agent_wakeup_requests" USING btree ((("payload" ->> 'issueId'))) WHERE "agent_wakeup_requests"."status" in ('queued', 'deferred_issue_execution')
          and "agent_wakeup_requests"."run_id" is null
          and ("agent_wakeup_requests"."payload" ->> 'issueId') is not null;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_transitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "subject" text NOT NULL,
  "event_class" text NOT NULL,
  "state_hash" text NOT NULL,
  "last_notified_at" timestamp with time zone DEFAULT now() NOT NULL,
  "notify_count" integer DEFAULT 1 NOT NULL,
  "acknowledged_channels" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "notification_transitions" ADD CONSTRAINT "notification_transitions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notification_transitions_company_subject_event_uq" ON "notification_transitions" USING btree ("company_id","subject","event_class");
