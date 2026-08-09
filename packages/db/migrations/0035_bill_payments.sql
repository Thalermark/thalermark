-- Partial payments for bills (TMC-192) — the accounts-payable mirror of 0031.
--
-- Settlement lived on the bill header — paid_at, payment_method,
-- payment_reference, payment_account_id — with one mark-paid transition flipping
-- the whole document. A bill was open or paid with nothing in between, so a
-- vendor deposit, a progress payment on a materials account, or a partial refund
-- from a supplier could not be recorded at all.
--
-- ADDITIVE, exactly like the invoice half. The header columns stay and are still
-- written on the full-payment path, so the AP aging report and every other
-- existing reader is untouched; these rows become the truth and status is
-- derived from sum(amount) against the bill amount. Nothing is backfilled: a
-- bill already marked paid keeps its header stamps and reads exactly as it did
-- before, with no payment rows at all.
--
-- payment_account_id is the one thing invoice_payments does not have and cannot
-- borrow. An invoice always settles into Cash (1000); a bill settles from
-- whichever account the money left, and paying half from the business account
-- and half in cash is the case it exists for — so the account rides the
-- payment, not the bill, and the ledger posting takes its code per row.
-- It resolves to Cash for now (the chart is seed-only and has no second account
-- money can leave from); writing it per payment from the start is what keeps
-- that a UI change later rather than a migration against live history.
--
-- Signed amounts — a refund from the vendor is a NEGATIVE row, which is why
-- there is no CHECK (amount > 0). The posting is the same two lines with the
-- sides flipped, so AP nets correctly without a second concept.
SET search_path TO public;--> statement-breakpoint
CREATE TABLE "bill_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"payment_account_id" uuid,
	"amount" numeric(15, 2) NOT NULL,
	"paid_on" date NOT NULL,
	"method" text NOT NULL,
	"reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bill_payments" ADD CONSTRAINT "bill_payments_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_payments" ADD CONSTRAINT "bill_payments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- CASCADE, matching invoice_payments.invoice_id: a payment has no meaning
-- without the bill it settles.
ALTER TABLE "bill_payments" ADD CONSTRAINT "bill_payments_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- RESTRICT, matching bills.payment_account_id: a COA row with postings against
-- it must not vanish underneath them.
ALTER TABLE "bill_payments" ADD CONSTRAINT "bill_payments_payment_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("payment_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bill_payments_account_id_idx" ON "bill_payments" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "bill_payments_bill_id_idx" ON "bill_payments" USING btree ("account_id","bill_id","paid_on");--> statement-breakpoint
CREATE INDEX "bill_payments_company_paid_on_idx" ON "bill_payments" USING btree ("account_id","company_id","paid_on");--> statement-breakpoint
ALTER TABLE "bill_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "bill_payments_tenant_isolation" ON "bill_payments" USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "bill_payments" TO thalermark_app;--> statement-breakpoint
GRANT SELECT ON TABLE "bill_payments" TO thalermark_staff_readonly;
