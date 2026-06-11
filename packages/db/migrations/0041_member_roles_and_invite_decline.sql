ALTER TABLE "invitations" ADD COLUMN "declined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "role" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
-- Backfill: the earliest membership in each account is its creator → 'owner'.
-- Runs before the partial unique index so the index builds over exactly one
-- owner per account. DISTINCT ON picks the min created_at per account, with id
-- breaking ties; uuidv7 ids are time-ordered, so this is the first membership
-- written for the account (the personal-account seed, or the inviter).
UPDATE "memberships" SET "role" = 'owner' WHERE "id" IN (
  SELECT DISTINCT ON ("account_id") "id" FROM "memberships"
  ORDER BY "account_id", "created_at" ASC, "id" ASC
);--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_one_owner_per_account" ON "memberships" USING btree ("account_id") WHERE role = 'owner';--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_role_check" CHECK (role in ('owner', 'member'));