-- TMC-268 — delete my profile, without gutting the audit trail.
--
-- Deleting a person and keeping the books honest pull in opposite directions.
-- The audit trail's whole job is "who did this", and `actor_user_id` resolves
-- the name by joining auth_user. Remove the person and every row they touched
-- reads "Unknown" — so an owner whose helpers come and go loses the record of
-- who did the work, which is the opposite of what an audit trail is for.
--
-- So the name is snapshotted onto the row. The read prefers the LIVE name and
-- falls back to this, which means a rename still propagates through history for
-- someone who is still here, and only a deleted profile pins to the snapshot.
SET search_path TO public;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "actor_name" text;--> statement-breakpoint
-- Backfill from the actor as they are named today. A one-time write to a table
-- that is otherwise append-only (RLS forbids UPDATE/DELETE; migration 0009).
-- Permitted here because it adds a column's value rather than altering history:
-- no existing field changes, and the rows keep saying what they always said.
-- Runs as the migration role, which is not subject to those policies.
UPDATE "audit_events" AS ae
   SET "actor_name" = u."name"
  FROM "auth_user" AS u
 WHERE u."id" = ae."actor_user_id"
   AND u."name" IS NOT NULL;--> statement-breakpoint
-- Deleted profiles are tombstoned rather than removed: audit_events.actor_user_id
-- is NOT NULL with an FK here, so the row has to survive for the history to. The
-- personal data does not — the delete path blanks the name and replaces the email
-- with a non-routable placeholder, which also frees the real address for a fresh
-- sign-up later.
ALTER TABLE "auth_user" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_user_deleted_at_idx" ON "auth_user" ("deleted_at") WHERE "deleted_at" IS NOT NULL;
