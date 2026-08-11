-- TMC-227 — remembering what the customer was originally told.
--
-- Correcting a sent invoice is same-row by design: the document keeps its
-- number, its public token and its payments, so the link in the customer's
-- inbox never dies and the numbering never gains an INV-0007-2. What that
-- costs is history — once the pulled-back draft is edited, nothing on the
-- invoice row remembers the figure that was actually sent. These two tables
-- are that memory, one row per pull-back, written in the same transaction as
-- the sent → draft transition.
--
-- They are also the visible half of the feature. QuickBooks edits silently and
-- keeps its audit log private; Thalermark prints "Revised Aug 11, 2026 — the
-- total was $450.00" on the very page the recipient was going to pay from.
-- That needs a durable snapshot, not a reconstruction from audit diffs.
--
-- WRITE-ONCE — no updated_at, and no UPDATE path in the app. The snapshot is
-- deliberately narrow (total, and for invoices the two document dates) rather
-- than a whole-invoice copy: those are the fields a recipient can act on and
-- the ones the ledger reversal moved. The operator's full before/after diff
-- already lives in audit_events.
--
-- Two concrete tables rather than one polymorphic document_revisions, matching
-- the rest of the schema: a real foreign key to the document is worth more
-- than a saved CREATE TABLE. The estimate side carries no dates because
-- estimates post nothing to the ledger — there is no period for a reversal to
-- land in, so the quoted number is the whole story.
--
-- Nothing is added to invoices or estimates. "Being revised" is DERIVED —
-- status = 'draft' AND sent_at IS NOT NULL — a state unreachable before this
-- change, so no existing row's meaning moves.
SET search_path TO public;--> statement-breakpoint
CREATE TABLE "estimate_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"estimate_id" uuid NOT NULL,
	"revised_at" timestamp with time zone NOT NULL,
	"previous_total" numeric(15, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"revised_at" timestamp with time zone NOT NULL,
	"previous_total" numeric(15, 2) NOT NULL,
	"previous_issue_date" date NOT NULL,
	"previous_due_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "estimate_revisions" ADD CONSTRAINT "estimate_revisions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_revisions" ADD CONSTRAINT "estimate_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- CASCADE, matching invoice_payments.invoice_id: a revision of a document that
-- no longer exists is not a record worth keeping.
ALTER TABLE "estimate_revisions" ADD CONSTRAINT "estimate_revisions_estimate_id_estimates_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_revisions" ADD CONSTRAINT "invoice_revisions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_revisions" ADD CONSTRAINT "invoice_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_revisions" ADD CONSTRAINT "invoice_revisions_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "estimate_revisions_account_id_idx" ON "estimate_revisions" USING btree ("account_id");--> statement-breakpoint
-- Backs the only read there is: every revision of one document, in date order,
-- for the detail page, the customer's page and the amended email.
CREATE INDEX "estimate_revisions_estimate_id_idx" ON "estimate_revisions" USING btree ("account_id","estimate_id","revised_at");--> statement-breakpoint
CREATE INDEX "invoice_revisions_account_id_idx" ON "invoice_revisions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "invoice_revisions_invoice_id_idx" ON "invoice_revisions" USING btree ("account_id","invoice_id","revised_at");--> statement-breakpoint
ALTER TABLE "estimate_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "estimate_revisions_tenant_isolation" ON "estimate_revisions" USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));--> statement-breakpoint
ALTER TABLE "invoice_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "invoice_revisions_tenant_isolation" ON "invoice_revisions" USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "estimate_revisions" TO thalermark_app;--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "invoice_revisions" TO thalermark_app;--> statement-breakpoint
GRANT SELECT ON TABLE "estimate_revisions" TO thalermark_staff_readonly;--> statement-breakpoint
GRANT SELECT ON TABLE "invoice_revisions" TO thalermark_staff_readonly;
