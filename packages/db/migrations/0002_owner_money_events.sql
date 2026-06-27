-- The collapsed 0000_baseline is a pg_dump, which runs
-- `set_config('search_path', '', false)` — emptying the search_path for the
-- whole migrator session. drizzle-kit's generated DDL is unqualified, so on a
-- fresh DB (baseline + later files applied in one session) an unqualified
-- CREATE TABLE errors with "no schema has been selected to create in". Restore
-- it here as the first statement (0001 does the same; it persists for the rest
-- of the session, but a fresh-DB session may apply this file first).
SET search_path TO public;--> statement-breakpoint
CREATE TABLE "owner_money_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"occurred_on" date NOT NULL,
	"memo" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "owner_money_events" ADD CONSTRAINT "owner_money_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_money_events" ADD CONSTRAINT "owner_money_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "owner_money_events_account_id_idx" ON "owner_money_events" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "owner_money_events_company_id_idx" ON "owner_money_events" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "owner_money_events_account_occurred_at_idx" ON "owner_money_events" USING btree ("account_id","occurred_on" DESC NULLS LAST,"created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
-- amount > 0, mirroring expenses_amount_positive_check / bills_amount_positive_check
-- / journal_lines. Drizzle doesn't track CHECK constraints from the schema, so
-- this is hand-added here (the baseline carries the sibling checks the same way).
ALTER TABLE "owner_money_events" ADD CONSTRAINT "owner_money_events_amount_positive_check" CHECK ("amount" > 0);--> statement-breakpoint
-- Row-level tenant isolation — same NULLIF idiom as every other tenant table.
-- drizzle-kit generate emits only table/FK/index DDL; RLS + grants live in
-- hand-written SQL (the policy model is not declared in the Drizzle schema).
ALTER TABLE "owner_money_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "owner_money_events_tenant_isolation" ON "owner_money_events" USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "owner_money_events" TO thalermark_app;--> statement-breakpoint
GRANT SELECT ON TABLE "owner_money_events" TO thalermark_staff_readonly;
