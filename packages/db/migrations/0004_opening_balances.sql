-- The collapsed 0000_baseline is a pg_dump that empties the session search_path,
-- and drizzle-kit's generated DDL is unqualified — restore it as the first
-- statement so a fresh-DB session can apply this file (0001–0003 do the same).
SET search_path TO public;--> statement-breakpoint
CREATE TABLE "opening_balances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"as_of_date" date NOT NULL,
	"cash" numeric(15, 2) DEFAULT '0' NOT NULL,
	"receivables" numeric(15, 2) DEFAULT '0' NOT NULL,
	"payables" numeric(15, 2) DEFAULT '0' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "opening_balances" ADD CONSTRAINT "opening_balances_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_balances" ADD CONSTRAINT "opening_balances_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "opening_balances_account_id_idx" ON "opening_balances" USING btree ("account_id");--> statement-breakpoint
-- One ACTIVE opening balance per company (a starting position is singular); a
-- soft-deleted row doesn't block setting a fresh one.
CREATE UNIQUE INDEX "opening_balances_company_active_uq" ON "opening_balances" USING btree ("company_id") WHERE "opening_balances"."deleted_at" is null;--> statement-breakpoint
-- Non-negative amounts (the figures are entered as plain positives; what you owe
-- is captured by `payables`, not a negative cash). Drizzle doesn't track CHECKs,
-- so it's hand-added here like the sibling amount checks.
ALTER TABLE "opening_balances" ADD CONSTRAINT "opening_balances_amounts_nonneg_check" CHECK ("cash" >= 0 AND "receivables" >= 0 AND "payables" >= 0);--> statement-breakpoint
-- Row-level tenant isolation — same NULLIF idiom as every other tenant table.
-- RLS + grants live in hand-written SQL (not declared in the Drizzle schema).
ALTER TABLE "opening_balances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "opening_balances_tenant_isolation" ON "opening_balances" USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "opening_balances" TO thalermark_app;--> statement-breakpoint
GRANT SELECT ON TABLE "opening_balances" TO thalermark_staff_readonly;
