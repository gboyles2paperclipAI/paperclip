ALTER TABLE "heartbeat_runs" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;
ALTER TABLE "heartbeat_runs" ADD COLUMN "fallback_from" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN "fallback_to" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN "fallback_success" boolean;
ALTER TABLE "heartbeat_runs" ADD COLUMN "duration_ms" integer;

UPDATE "heartbeat_runs"
SET "retry_count" = greatest(
  coalesce("scheduled_retry_attempt", 0),
  coalesce("process_loss_retry_count", 0)
);

UPDATE "heartbeat_runs"
SET "duration_ms" = greatest(0, floor(extract(epoch from ("finished_at" - "started_at")) * 1000)::integer)
WHERE "started_at" IS NOT NULL
  AND "finished_at" IS NOT NULL;
