-- Contacts unification (Xero-style): rename `customers` → `contacts` and add
-- the customer/vendor role flags. This is a hand-written migration because
-- drizzle-kit renders a rename as drop + create, which would lose data AND
-- force re-establishing RLS / FKs / indexes by hand. A plain RENAME keeps the
-- policy, inbound FKs, and indexes attached automatically.
--
-- The dev/CI database is disposable (pre-alpha, no live clients), so this is
-- not a data-preservation exercise — the reason to hand-write it is correctness.
-- A later, separate PR collapses the whole migration history into a clean
-- baseline before the first real release; until then DO NOT run
-- `drizzle-kit generate` (it would re-diff against the 0052 snapshot, which
-- still knows `customers`) — hand-write any migrations in the meantime.
--
-- squawk's renaming-table / renaming-column rules are deliberately ignored
-- here: they fire only against populated production tables and we have none.
--
-- FK *constraint* names keep their old `customers` token (e.g.
-- invoices_customer_id_contacts_id_fk would be the clean name); they are not
-- renamed because they are never inspected at runtime and the baseline reset
-- regenerates them. Indexes and the RLS policy ARE renamed so `\d contacts`
-- reads clean.

-- squawk-ignore renaming-table
ALTER TABLE "customers" RENAME TO "contacts";
--> statement-breakpoint
ALTER INDEX "customers_account_id_idx" RENAME TO "contacts_account_id_idx";
--> statement-breakpoint
ALTER INDEX "customers_company_id_idx" RENAME TO "contacts_company_id_idx";
--> statement-breakpoint
ALTER INDEX "customers_name_idx" RENAME TO "contacts_name_idx";
--> statement-breakpoint
ALTER INDEX "customers_email_idx" RENAME TO "contacts_email_idx";
--> statement-breakpoint
ALTER INDEX "customers_account_created_at_idx" RENAME TO "contacts_account_created_at_idx";
--> statement-breakpoint
ALTER POLICY "customers_tenant_isolation" ON "contacts" RENAME TO "contacts_tenant_isolation";
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "is_customer" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "is_vendor" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- squawk-ignore renaming-column
ALTER TABLE "invoices" RENAME COLUMN "customer_id" TO "contact_id";
--> statement-breakpoint
ALTER INDEX "invoices_customer_id_idx" RENAME TO "invoices_contact_id_idx";
--> statement-breakpoint
-- squawk-ignore renaming-column
ALTER TABLE "estimates" RENAME COLUMN "customer_id" TO "contact_id";
--> statement-breakpoint
ALTER INDEX "estimates_customer_id_idx" RENAME TO "estimates_contact_id_idx";
--> statement-breakpoint
-- squawk-ignore renaming-column
ALTER TABLE "recurring_invoices" RENAME COLUMN "customer_id" TO "contact_id";
--> statement-breakpoint
ALTER INDEX "recurring_invoices_customer_id_idx" RENAME TO "recurring_invoices_contact_id_idx";
--> statement-breakpoint
-- squawk-ignore renaming-column
ALTER TABLE "expenses" RENAME COLUMN "customer_id" TO "customer_contact_id";
--> statement-breakpoint
ALTER INDEX "expenses_customer_id_idx" RENAME TO "expenses_customer_contact_id_idx";
--> statement-breakpoint
UPDATE "audit_events" SET "entity_type" = 'contact' WHERE "entity_type" = 'customer';
