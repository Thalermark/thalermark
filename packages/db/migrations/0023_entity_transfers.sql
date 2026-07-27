-- One business handing its books to another — a sole proprietor incorporating.
--
-- A table rather than a column on companies, because what matters is not the
-- link but the FACTS of the handoff: when it took effect, what the user decided
-- about outstanding invoices, and the two journal entries that moved the
-- balances. Those are what make it auditable and reversible.
--
-- Also adds 3900 to every chart. The predecessor's transfer-out entry needs
-- somewhere to put the plug, and putting it on 3000 would leave a final balance
-- sheet reading "Owner's Equity −$X" next to "Net income +$X" — arithmetically
-- right, alarming to read, and wrong in spirit: the equity did not go negative,
-- it went somewhere else. Account codes are identical across all five entity
-- types by design (ledger.ts posts by literal code), so one code serves every
-- business. Existing companies are backfilled here; new ones get it from the
-- seed.
SET search_path TO public;--> statement-breakpoint
CREATE TABLE "entity_transfers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"predecessor_company_id" uuid NOT NULL,
	"successor_company_id" uuid NOT NULL,
	"effective_date" date NOT NULL,
	"open_invoices_disposition" text DEFAULT 'stay' NOT NULL,
	"out_journal_entry_id" uuid NOT NULL,
	"in_journal_entry_id" uuid NOT NULL,
	"options" jsonb,
	"reversed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entity_transfers" ADD CONSTRAINT "entity_transfers_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_transfers" ADD CONSTRAINT "entity_transfers_predecessor_fk" FOREIGN KEY ("predecessor_company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_transfers" ADD CONSTRAINT "entity_transfers_successor_fk" FOREIGN KEY ("successor_company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entity_transfers_account_id_idx" ON "entity_transfers" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "entity_transfers_predecessor_idx" ON "entity_transfers" USING btree ("predecessor_company_id");--> statement-breakpoint
-- A company succeeds at most one predecessor at a time; reversing frees it.
CREATE UNIQUE INDEX "entity_transfers_successor_active_uq" ON "entity_transfers" USING btree ("successor_company_id") WHERE "entity_transfers"."reversed_at" is null;--> statement-breakpoint
-- A business cannot hand its books to itself.
ALTER TABLE "entity_transfers" ADD CONSTRAINT "entity_transfers_distinct_companies_check" CHECK ("predecessor_company_id" <> "successor_company_id");--> statement-breakpoint
ALTER TABLE "entity_transfers" ADD CONSTRAINT "entity_transfers_disposition_check" CHECK ("open_invoices_disposition" IN ('stay','transfer'));--> statement-breakpoint
ALTER TABLE "entity_transfers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "entity_transfers_tenant_isolation" ON "entity_transfers" USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "entity_transfers" TO thalermark_app;--> statement-breakpoint
GRANT SELECT ON TABLE "entity_transfers" TO thalermark_staff_readonly;--> statement-breakpoint
-- 3900 for every existing company. Idempotent via NOT EXISTS on
-- (company_id, code), matching the 0001 / 0003 backfills.
INSERT INTO "chart_of_accounts" ("id", "account_id", "company_id", "code", "name", "account_type", "normal_balance", "tax_mapping", "is_active")
SELECT gen_random_uuid(), c."account_id", c."id", '3900', 'Business transferred out', 'equity', 'credit', NULL, true
FROM "companies" c
WHERE NOT EXISTS (
  SELECT 1 FROM "chart_of_accounts" coa WHERE coa."company_id" = c."id" AND coa."code" = '3900'
);
