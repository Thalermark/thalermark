-- Partial payments and deposits (TMC-187).
--
-- Settlement lived on the invoice header — paid_at, payment_method,
-- payment_reference, processing_fee — with one mark-paid transition flipping the
-- whole document. An invoice was paid or unpaid with nothing in between, in a
-- product whose stated audience takes 50% down.
--
-- ADDITIVE. The header columns stay and are still written on the full-payment
-- path, so every existing reader is untouched; these rows become the truth and
-- status is derived from sum(amount) against the invoice total. Nothing is
-- backfilled: an invoice already marked paid keeps its header stamps and reads
-- exactly as it did before, with no payment rows at all.
--
-- Signed amounts — a refund or credit note is a NEGATIVE row, which is why there
-- is no CHECK (amount > 0). The ledger posting for one is the same lines with
-- the sides flipped, so AR nets correctly without a second concept.
SET search_path TO public;--> statement-breakpoint
CREATE TABLE "invoice_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"received_on" date NOT NULL,
	"method" text NOT NULL,
	"reference" text,
	"processing_fee" numeric(15, 2),
	"stripe_payment_intent_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- CASCADE, unlike time_entries.billed_invoice_id which is SET NULL. A payment
-- has no meaning without the invoice it settles; an hour worked still does.
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_payments_account_id_idx" ON "invoice_payments" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "invoice_payments_invoice_id_idx" ON "invoice_payments" USING btree ("account_id","invoice_id","received_on");--> statement-breakpoint
CREATE INDEX "invoice_payments_company_received_on_idx" ON "invoice_payments" USING btree ("account_id","company_id","received_on");--> statement-breakpoint
-- Stripe idempotency: a webhook can be delivered more than once for one intent,
-- and without this a retry credits the customer twice. Partial, because every
-- manual payment leaves the column null and those must not collide.
CREATE UNIQUE INDEX "invoice_payments_stripe_intent_uq" ON "invoice_payments" USING btree ("stripe_payment_intent_id") WHERE "invoice_payments"."stripe_payment_intent_id" is not null;--> statement-breakpoint
ALTER TABLE "invoice_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "invoice_payments_tenant_isolation" ON "invoice_payments" USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "invoice_payments" TO thalermark_app;--> statement-breakpoint
GRANT SELECT ON TABLE "invoice_payments" TO thalermark_staff_readonly;
