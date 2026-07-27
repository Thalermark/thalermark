-- The collapsed 0000_baseline is a pg_dump that empties the session search_path,
-- and drizzle-kit's generated DDL is unqualified — restore it as the first
-- statement so a fresh-DB session can apply this file (every post-baseline
-- migration does the same).
SET search_path TO public;--> statement-breakpoint
CREATE TABLE "period_closes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"fiscal_year" bigint NOT NULL,
	"closed_through" timestamp with time zone NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"net_income" numeric(15, 2) NOT NULL,
	"equity_code" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "period_closes" ADD CONSTRAINT "period_closes_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_closes" ADD CONSTRAINT "period_closes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "period_closes_account_id_idx" ON "period_closes" USING btree ("account_id");--> statement-breakpoint
-- The period lock's read path: newest ACTIVE close for a company. Every posting
-- in the product consults this, so it is a partial index over the live rows only.
CREATE INDEX "period_closes_company_active_idx" ON "period_closes" USING btree ("company_id","closed_through") WHERE "period_closes"."deleted_at" is null;--> statement-breakpoint
-- A fiscal year is closed at most once at a time. Re-opening soft-deletes the
-- row, which frees the year to be closed again.
CREATE UNIQUE INDEX "period_closes_company_year_active_uq" ON "period_closes" USING btree ("company_id","fiscal_year") WHERE "period_closes"."deleted_at" is null;--> statement-breakpoint
-- Sanity bounds on the year. Drizzle doesn't track CHECKs, so it's hand-added
-- here like the sibling amount checks on opening_balances.
ALTER TABLE "period_closes" ADD CONSTRAINT "period_closes_fiscal_year_range_check" CHECK ("fiscal_year" >= 1900 AND "fiscal_year" <= 2999);--> statement-breakpoint
-- Row-level tenant isolation — same NULLIF idiom as every other tenant table.
-- RLS + grants live in hand-written SQL (not declared in the Drizzle schema).
ALTER TABLE "period_closes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "period_closes_tenant_isolation" ON "period_closes" USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "period_closes" TO thalermark_app;--> statement-breakpoint
GRANT SELECT ON TABLE "period_closes" TO thalermark_staff_readonly;
