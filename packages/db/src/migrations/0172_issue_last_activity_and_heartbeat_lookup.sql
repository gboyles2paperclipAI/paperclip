ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "last_activity_at" timestamp with time zone;--> statement-breakpoint

WITH comment_activity AS (
  SELECT "issue_id", MAX("created_at") AS "latest_at"
  FROM "issue_comments"
  GROUP BY "issue_id"
), log_activity AS (
  SELECT "entity_id", MAX("created_at") AS "latest_at"
  FROM "activity_log"
  WHERE "entity_type" = 'issue'
    AND "action" NOT IN (
      'issue.read_marked',
      'issue.read_unmarked',
      'issue.inbox_archived',
      'issue.inbox_unarchived'
    )
  GROUP BY "entity_id"
), backfill AS (
  SELECT
    i."id",
    GREATEST(
      i."updated_at",
      COALESCE(c."latest_at", to_timestamp(0)),
      COALESCE(a."latest_at", to_timestamp(0))
    ) AS "last_activity_at"
  FROM "issues" i
  LEFT JOIN comment_activity c ON c."issue_id" = i."id"
  LEFT JOIN log_activity a ON a."entity_id" = i."id"::text
)
UPDATE "issues" i
SET "last_activity_at" = b."last_activity_at"
FROM backfill b
WHERE i."id" = b."id"
  AND i."last_activity_at" IS NULL;--> statement-breakpoint

ALTER TABLE "issues" ALTER COLUMN "last_activity_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "issues" ALTER COLUMN "last_activity_at" SET NOT NULL;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "paperclip_set_issue_last_activity_at"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."last_activity_at" := COALESCE(NEW."updated_at", NEW."last_activity_at", now());
  ELSIF NEW."status" IS DISTINCT FROM OLD."status" THEN
    NEW."last_activity_at" := GREATEST(
      COALESCE(NEW."last_activity_at", to_timestamp(0)),
      COALESCE(NEW."updated_at", to_timestamp(0)),
      now()
    );
  ELSIF NEW."updated_at" IS DISTINCT FROM OLD."updated_at" THEN
    NEW."last_activity_at" := GREATEST(
      COALESCE(NEW."last_activity_at", to_timestamp(0)),
      COALESCE(NEW."updated_at", to_timestamp(0))
    );
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS "issues_maintain_last_activity_at" ON "issues";--> statement-breakpoint
CREATE TRIGGER "issues_maintain_last_activity_at"
BEFORE INSERT OR UPDATE OF "updated_at", "status" ON "issues"
FOR EACH ROW EXECUTE FUNCTION "paperclip_set_issue_last_activity_at"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "paperclip_touch_issue_from_comment"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "issues"
  SET "last_activity_at" = GREATEST("last_activity_at", NEW."created_at")
  WHERE "id" = NEW."issue_id"
    AND "company_id" = NEW."company_id";
  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS "issue_comments_touch_issue_last_activity" ON "issue_comments";--> statement-breakpoint
CREATE TRIGGER "issue_comments_touch_issue_last_activity"
AFTER INSERT OR UPDATE ON "issue_comments"
FOR EACH ROW EXECUTE FUNCTION "paperclip_touch_issue_from_comment"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "paperclip_touch_issue_from_activity"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."entity_type" = 'issue'
    AND NEW."action" NOT IN (
      'issue.read_marked',
      'issue.read_unmarked',
      'issue.inbox_archived',
      'issue.inbox_unarchived'
    ) THEN
    UPDATE "issues"
    SET "last_activity_at" = GREATEST("last_activity_at", NEW."created_at")
    WHERE "id"::text = NEW."entity_id"
      AND "company_id" = NEW."company_id";
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS "activity_log_touch_issue_last_activity" ON "activity_log";--> statement-breakpoint
CREATE TRIGGER "activity_log_touch_issue_last_activity"
AFTER INSERT ON "activity_log"
FOR EACH ROW EXECUTE FUNCTION "paperclip_touch_issue_from_activity"();--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "issues_company_last_activity_idx"
  ON "issues" USING btree ("company_id", "last_activity_at" DESC, "updated_at" DESC, "id" DESC);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_issue_created_at_desc_idx"
  ON "heartbeat_runs" USING btree (
    "company_id",
    ("context_snapshot" ->> 'issueId'),
    "created_at" DESC,
    "id" DESC
  );
