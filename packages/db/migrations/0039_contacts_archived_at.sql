-- TMC-232 — contacts archive, never hard-delete.
--
-- A contact added with a typo, or duplicated by an import, is permanent today:
-- there is no DELETE endpoint and no flag, so it sits in every picker forever.
--
-- Hard delete is not the answer and never can be. invoices.contact_id is
-- RESTRICT on delete, and deliberately so — an invoice has to keep naming who
-- it was billed to, or the history stops being history. Archiving gives the
-- picker its removal while the documents keep their reference.
--
-- Nullable with no default: every existing contact is active, which is what
-- every existing contact already is. No backfill, no behaviour change until
-- someone archives something.
--
-- Written by hand rather than generated: the drizzle snapshot had drifted
-- behind the hand-authored 0037/0038, so `generate` re-emitted their columns
-- too and the migration would have failed on the first ALTER.
SET search_path TO public;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
-- Every picker and the default contact list read WHERE archived_at IS NULL, on
-- a table where nearly every row qualifies. Partial on the negation so the
-- index holds only the archived minority and the common query keeps using the
-- existing keyset index rather than this one.
CREATE INDEX "contacts_archived_at_idx" ON "contacts" ("archived_at")
  WHERE "archived_at" IS NOT NULL;
