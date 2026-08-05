-- Job costing (TMC-174) — which job a cost was for.
--
-- A join table rather than a column on expenses, because one purchase routinely
-- covers several jobs: seed bought for three houses, each priced flat, never
-- line-itemed to anyone. No single foreign key expresses that.
--
-- invoice_id NULL is the SHARED pool — a deliberate "won't attribute this"
-- answer, distinct from no rows at all, which means the user never answered.
-- share is a fraction of the expense, not money, so it survives an edit to the
-- expense total.
--
-- Posts nothing to the ledger and is referenced by none of it. Dropping this
-- table would cost the job screen and nothing else.
SET search_path TO public;--> statement-breakpoint
CREATE TABLE "expense_allocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"expense_id" uuid NOT NULL,
	"invoice_id" uuid,
	"share" numeric(9, 6) DEFAULT '1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "expense_allocations" ADD CONSTRAINT "expense_allocations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_allocations" ADD CONSTRAINT "expense_allocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_allocations" ADD CONSTRAINT "expense_allocations_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Cascade, not restrict: deleting an invoice must not be blocked by a costing
-- tag, and losing the tag costs only the attribution.
ALTER TABLE "expense_allocations" ADD CONSTRAINT "expense_allocations_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- (0, 1]. The full set for one expense is required to sum to 1, enforced on
-- write in the API (which replaces the set atomically) rather than by a trigger.
ALTER TABLE "expense_allocations" ADD CONSTRAINT "expense_allocations_share_range_check" CHECK ("share" > 0 AND "share" <= 1);--> statement-breakpoint
CREATE INDEX "expense_allocations_account_id_idx" ON "expense_allocations" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "expense_allocations_expense_id_idx" ON "expense_allocations" USING btree ("expense_id");--> statement-breakpoint
CREATE INDEX "expense_allocations_invoice_id_idx" ON "expense_allocations" USING btree ("account_id","company_id","invoice_id");--> statement-breakpoint
-- Two partial uniques, not one plain unique: Postgres treats NULLs as distinct,
-- which would otherwise let one expense collect several "shared" rows.
CREATE UNIQUE INDEX "expense_allocations_expense_invoice_uq" ON "expense_allocations" USING btree ("expense_id","invoice_id") WHERE "expense_allocations"."invoice_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "expense_allocations_expense_shared_uq" ON "expense_allocations" USING btree ("expense_id") WHERE "expense_allocations"."invoice_id" is null;--> statement-breakpoint
ALTER TABLE "expense_allocations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "expense_allocations_tenant_isolation" ON "expense_allocations" USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "expense_allocations" TO thalermark_app;--> statement-breakpoint
GRANT SELECT ON TABLE "expense_allocations" TO thalermark_staff_readonly;
