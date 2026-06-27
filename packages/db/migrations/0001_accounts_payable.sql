-- The collapsed 0000_baseline is a pg_dump, which runs
-- `set_config('search_path', '', false)` — emptying the search_path for the
-- whole migrator session. drizzle-kit's generated DDL is unqualified, so on a
-- fresh DB (baseline + this file applied in one session) an unqualified
-- CREATE TABLE errors with "no schema has been selected to create in". Restore
-- it here, in the first post-baseline migration; it persists for the rest of
-- the session (later migrations inherit it; incremental applies on an existing
-- DB already have public in the default path). Future post-baseline migrations
-- can rely on this once it's applied.
SET search_path TO public;--> statement-breakpoint
CREATE TABLE "bills" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"category_account_id" uuid NOT NULL,
	"payment_account_id" uuid,
	"amount" numeric(15, 2) NOT NULL,
	"bill_date" date NOT NULL,
	"due_date" date NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"reference" text,
	"memo" text,
	"status" text DEFAULT 'open' NOT NULL,
	"paid_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"payment_method" text,
	"payment_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_category_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("category_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_payment_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("payment_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bills_account_id_idx" ON "bills" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "bills_company_id_idx" ON "bills" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "bills_contact_id_idx" ON "bills" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "bills_category_account_id_idx" ON "bills" USING btree ("category_account_id");--> statement-breakpoint
CREATE INDEX "bills_payment_account_id_idx" ON "bills" USING btree ("payment_account_id");--> statement-breakpoint
CREATE INDEX "bills_status_idx" ON "bills" USING btree ("status");--> statement-breakpoint
CREATE INDEX "bills_account_created_at_idx" ON "bills" USING btree ("account_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "bills_open_due_idx" ON "bills" USING btree ("account_id","company_id","due_date") WHERE "bills"."status" = 'open';--> statement-breakpoint
-- amount > 0, mirroring expenses_amount_positive_check / journal_lines. Status
-- stays a plain-text app-layer enum (no CHECK), uniform with invoices/estimates.
-- Drizzle doesn't track CHECK constraints from the schema, so this is hand-added
-- here (the baseline carries the sibling checks the same way).
ALTER TABLE "bills" ADD CONSTRAINT "bills_amount_positive_check" CHECK ("amount" > 0);--> statement-breakpoint
-- Row-level tenant isolation — same NULLIF idiom as every other tenant table.
-- drizzle-kit generate emits only table/FK/index DDL; RLS + grants live in
-- hand-written SQL (the policy model is not declared in the Drizzle schema).
ALTER TABLE "bills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "bills_tenant_isolation" ON "bills" USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "bills" TO thalermark_app;--> statement-breakpoint
GRANT SELECT ON TABLE "bills" TO thalermark_staff_readonly;--> statement-breakpoint
-- Backfill Accounts Payable (2000) into every existing company's chart of
-- accounts so bills have somewhere to post. New companies get it from the
-- updated SOLE_PROP_COA seed; this covers companies created before this
-- migration. Idempotent via NOT EXISTS on (company_id, code).
INSERT INTO "chart_of_accounts" ("id", "account_id", "company_id", "code", "name", "account_type", "normal_balance", "tax_mapping", "is_active")
SELECT gen_random_uuid(), c."account_id", c."id", '2000', 'Accounts Payable', 'liability', 'credit', NULL, true
FROM "companies" c
WHERE NOT EXISTS (
  SELECT 1 FROM "chart_of_accounts" coa WHERE coa."company_id" = c."id" AND coa."code" = '2000'
);