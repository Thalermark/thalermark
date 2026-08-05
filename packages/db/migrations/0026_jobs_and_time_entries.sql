-- Jobs (TMC-181) and time entries (TMC-180).
--
-- A job is the unit of work the user names — "the Smith job", "Tuesdays at the
-- Chens" — and it exists from the moment work starts, before anything is
-- billed. Job costing shipped with the invoice standing in for the job, which
-- held only because every one of its inputs arrives AFTER the invoice. Tracked
-- time inverts that: the work happens first and the invoice is the OUTPUT of
-- the hours, so at 6pm there is nothing to attach to.
--
-- OPT-IN AND ADDITIVE — nothing is backfilled. invoices.job_id and
-- expense_allocations.job_id are both nullable, and anything that ignores jobs
-- behaves exactly as before. The acceptance test for the whole model: a company
-- with no jobs gets identical job-margin output.
--
-- Posts nothing to the ledger, referenced by no journal entry. A tag layer, not
-- a route — the same property expense_allocations has.
--
-- NOTE: hand-written. `drizzle-kit generate` re-emits already-applied objects
-- here (oauth_*, entity_transfers, period_closes, the expense_allocations
-- CREATE) because the pre-0026 snapshot lagged the hand-maintained baseline. The
-- 0026 snapshot beside this file is complete, so later generates diff cleanly.
SET search_path TO public;--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"contact_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"started_on" date,
	"ended_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "time_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"entry_date" date NOT NULL,
	"minutes" bigint NOT NULL,
	"note" text,
	"rate" numeric(15, 4),
	"source_item_id" uuid,
	"billed_invoice_id" uuid,
	"membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- SET NULL, unlike invoices.contact_id which is RESTRICT. An invoice without a
-- customer is meaningless; a job without one is merely unlabelled.
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_source_item_id_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- SET NULL, deliberately NOT cascade — the one place this disagrees with
-- expense_allocations. Deleting an invoice returns the hours to unbilled so they
-- can be billed again; cascading would destroy the record that the work ever
-- happened, a far worse loss than a dropped attribution.
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_billed_invoice_id_invoices_id_fk" FOREIGN KEY ("billed_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_account_id_idx" ON "jobs" USING btree ("account_id");--> statement-breakpoint
-- Backs the open-jobs picker, the hottest read: one company, almost always
-- status open.
CREATE INDEX "jobs_company_status_idx" ON "jobs" USING btree ("account_id","company_id","status");--> statement-breakpoint
-- Keyset list: WHERE account_id ORDER BY name ASC, id ASC.
CREATE INDEX "jobs_account_name_idx" ON "jobs" USING btree ("account_id","name","id");--> statement-breakpoint
CREATE INDEX "jobs_contact_id_idx" ON "jobs" USING btree ("account_id","contact_id");--> statement-breakpoint
CREATE INDEX "time_entries_account_id_idx" ON "time_entries" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "time_entries_job_id_idx" ON "time_entries" USING btree ("account_id","company_id","job_id");--> statement-breakpoint
-- Backs the unbilled picker (billed_invoice_id IS NULL) and the reverse lookup
-- when an invoice is deleted.
CREATE INDEX "time_entries_billed_invoice_id_idx" ON "time_entries" USING btree ("account_id","company_id","billed_invoice_id");--> statement-breakpoint
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "jobs_tenant_isolation" ON "jobs" USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));--> statement-breakpoint
ALTER TABLE "time_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "time_entries_tenant_isolation" ON "time_entries" USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "jobs" TO thalermark_app;--> statement-breakpoint
GRANT SELECT ON TABLE "jobs" TO thalermark_staff_readonly;--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "time_entries" TO thalermark_app;--> statement-breakpoint
GRANT SELECT ON TABLE "time_entries" TO thalermark_staff_readonly;--> statement-breakpoint
-- An invoice optionally belongs to a job. SET NULL, never cascade: a job owning
-- several invoices is the entire point (a deposit plus a final, an ongoing
-- arrangement billed biweekly), so deleting a job must orphan its invoices
-- rather than destroy them.
ALTER TABLE "invoices" ADD COLUMN "job_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoices_job_id_idx" ON "invoices" USING btree ("account_id","company_id","job_id");--> statement-breakpoint
-- Job-grain cost attribution, added ALONGSIDE invoice_id rather than replacing
-- it. This addition is also what defuses the hazard flagged when job costing
-- shipped: invoice_id's cascade would have started dropping tags belonging to
-- the JOB once a job owned several invoices. It never does, because job-grain
-- tags live in this column and invoice_id keeps its original narrower meaning.
ALTER TABLE "expense_allocations" ADD COLUMN "job_id" uuid;--> statement-breakpoint
ALTER TABLE "expense_allocations" ADD CONSTRAINT "expense_allocations_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- A row points at an invoice OR a job OR neither. NEITHER is the shared pool —
-- still a real answer, still never auto-apportioned. NOT VALID then VALIDATE so
-- the constraint lands without holding ACCESS EXCLUSIVE for a full-table scan;
-- every existing row has job_id NULL and passes trivially.
ALTER TABLE "expense_allocations" ADD CONSTRAINT "expense_allocations_single_grain_check" CHECK (num_nonnulls("invoice_id", "job_id") <= 1) NOT VALID;--> statement-breakpoint
ALTER TABLE "expense_allocations" VALIDATE CONSTRAINT "expense_allocations_single_grain_check";--> statement-breakpoint
CREATE UNIQUE INDEX "expense_allocations_expense_job_uq" ON "expense_allocations" USING btree ("expense_id","job_id") WHERE "expense_allocations"."job_id" is not null;--> statement-breakpoint
CREATE INDEX "expense_allocations_job_id_idx" ON "expense_allocations" USING btree ("account_id","company_id","job_id");--> statement-breakpoint
-- Shared is now "neither pointer set", so the guard has to name both columns or
-- a job-tagged row would be mistaken for the shared one.
DROP INDEX "expense_allocations_expense_shared_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "expense_allocations_expense_shared_uq" ON "expense_allocations" USING btree ("expense_id") WHERE "expense_allocations"."invoice_id" is null and "expense_allocations"."job_id" is null;
