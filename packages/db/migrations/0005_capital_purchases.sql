-- The collapsed 0000_baseline is a pg_dump that empties the session search_path,
-- and drizzle-kit's generated DDL is unqualified — restore it as the first
-- statement so a fresh-DB session can apply this file (0001–0004 do the same).
SET search_path TO public;--> statement-breakpoint
CREATE TABLE "capital_purchases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"purchase_date" date NOT NULL,
	"funding" text NOT NULL,
	"down_payment" numeric(15, 2) DEFAULT '0' NOT NULL,
	"tax_treatment" text NOT NULL,
	"useful_life_years" bigint DEFAULT 5 NOT NULL,
	"vendor_contact_id" uuid,
	"memo" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "capital_purchases" ADD CONSTRAINT "capital_purchases_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capital_purchases" ADD CONSTRAINT "capital_purchases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capital_purchases" ADD CONSTRAINT "capital_purchases_vendor_contact_id_contacts_id_fk" FOREIGN KEY ("vendor_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "capital_purchases_account_id_idx" ON "capital_purchases" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "capital_purchases_company_id_idx" ON "capital_purchases" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "capital_purchases_vendor_contact_id_idx" ON "capital_purchases" USING btree ("vendor_contact_id");--> statement-breakpoint
CREATE INDEX "capital_purchases_account_purchase_at_idx" ON "capital_purchases" USING btree ("account_id","purchase_date" DESC NULLS LAST,"created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
-- amount > 0; down_payment between 0 and the amount (it can't exceed the cost).
-- Drizzle doesn't track CHECKs, so they're hand-added like the sibling tables.
ALTER TABLE "capital_purchases" ADD CONSTRAINT "capital_purchases_amount_positive_check" CHECK ("amount" > 0);--> statement-breakpoint
ALTER TABLE "capital_purchases" ADD CONSTRAINT "capital_purchases_down_payment_range_check" CHECK ("down_payment" >= 0 AND "down_payment" <= "amount");--> statement-breakpoint
-- Row-level tenant isolation — same NULLIF idiom as every other tenant table.
-- RLS + grants live in hand-written SQL (not declared in the Drizzle schema).
ALTER TABLE "capital_purchases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "capital_purchases_tenant_isolation" ON "capital_purchases" USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "capital_purchases" TO thalermark_app;--> statement-breakpoint
GRANT SELECT ON TABLE "capital_purchases" TO thalermark_staff_readonly;--> statement-breakpoint
-- Backfill the two new accounts into every existing company's chart so big
-- purchases have somewhere to post. New companies get them from the updated
-- SOLE_PROP_COA seed; this covers companies created before this migration.
-- Idempotent via NOT EXISTS on (company_id, code), matching 0001/0003.
INSERT INTO "chart_of_accounts" ("id", "account_id", "company_id", "code", "name", "account_type", "normal_balance", "tax_mapping", "is_active")
SELECT gen_random_uuid(), c."account_id", c."id", '1500', 'Vehicles & Equipment', 'asset', 'debit', NULL, true
FROM "companies" c
WHERE NOT EXISTS (
  SELECT 1 FROM "chart_of_accounts" coa WHERE coa."company_id" = c."id" AND coa."code" = '1500'
);--> statement-breakpoint
INSERT INTO "chart_of_accounts" ("id", "account_id", "company_id", "code", "name", "account_type", "normal_balance", "tax_mapping", "is_active")
SELECT gen_random_uuid(), c."account_id", c."id", '2700', 'Loans Payable', 'liability', 'credit', NULL, true
FROM "companies" c
WHERE NOT EXISTS (
  SELECT 1 FROM "chart_of_accounts" coa WHERE coa."company_id" = c."id" AND coa."code" = '2700'
);
