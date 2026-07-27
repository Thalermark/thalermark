-- Opening balances become a full opening trial balance.
--
-- Until now a company's starting position was three numbers — cash, receivables,
-- payables — posted against fixed accounts with Owner's Equity as the plug. That
-- covers someone starting fresh, and nothing else. It cannot express a
-- part-depreciated mower, an outstanding loan, sales tax already collected, or a
-- corporation's split between capital stock and retained earnings. Anyone
-- arriving from QuickBooks or Xero with real books had no way to enter them.
--
-- This is the shape those tools use (Xero calls it "conversion balances"): one
-- line per account, each with a side and an amount, balancing to zero. The three
-- plain questions stay — they're the right first ask, and they now simply
-- generate four lines behind the scenes.
--
-- The three columns are KEPT, not dropped:
--   * squawk's ban-drop-column is deliberately still armed (.squawk.toml keeps
--     the universally-destructive rules on), and
--   * they remain a faithful denormalization of the simple shape, so the plain
--     "what was in the bank" screen reads them directly without walking lines.
-- `shape` says which representation is authoritative for display. Lines are
-- always authoritative for POSTING, whichever shape produced them.
--
-- Existing rows are backfilled into lines below, preserving opening_balances.id
-- — journal_entries.source_entity_id points at it for
-- source_entity_type='opening_balance', and the edit-is-reverse-then-repost
-- discipline depends on that source group continuing to resolve.
SET search_path TO public;--> statement-breakpoint
ALTER TABLE "opening_balances" ADD COLUMN "shape" text DEFAULT 'simple' NOT NULL;--> statement-breakpoint
CREATE TABLE "opening_balance_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"opening_balance_id" uuid NOT NULL,
	"coa_account_id" uuid NOT NULL,
	"side" text NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "opening_balance_lines" ADD CONSTRAINT "opening_balance_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_balance_lines" ADD CONSTRAINT "opening_balance_lines_opening_balance_fk" FOREIGN KEY ("opening_balance_id") REFERENCES "public"."opening_balances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_balance_lines" ADD CONSTRAINT "opening_balance_lines_coa_account_fk" FOREIGN KEY ("coa_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "opening_balance_lines_account_id_idx" ON "opening_balance_lines" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "opening_balance_lines_parent_idx" ON "opening_balance_lines" USING btree ("opening_balance_id");--> statement-breakpoint
-- Positive amounts only; direction is carried by `side`, exactly as journal_lines
-- does it. A negative here would make two ways to say the same thing.
ALTER TABLE "opening_balance_lines" ADD CONSTRAINT "opening_balance_lines_amount_positive_check" CHECK ("amount" > 0);--> statement-breakpoint
ALTER TABLE "opening_balance_lines" ADD CONSTRAINT "opening_balance_lines_side_check" CHECK ("side" IN ('debit','credit'));--> statement-breakpoint
-- Row-level tenant isolation — same NULLIF idiom as every other tenant table.
ALTER TABLE "opening_balance_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "opening_balance_lines_tenant_isolation" ON "opening_balance_lines" USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "opening_balance_lines" TO thalermark_app;--> statement-breakpoint
GRANT SELECT ON TABLE "opening_balance_lines" TO thalermark_staff_readonly;--> statement-breakpoint
-- Backfill: expand every ACTIVE opening balance into the four lines its three
-- figures always implied — Dr Cash / Dr A/R / Cr A/P with Owner's Equity as the
-- sign-aware plug. Zero legs are skipped, matching what postJournalEntry already
-- dropped, so a cash-only starting position yields the same 2-line entry it
-- posted before. Soft-deleted rows are left alone: their postings are already
-- reversed and nothing reads them.
INSERT INTO "opening_balance_lines" ("id", "account_id", "opening_balance_id", "coa_account_id", "side", "amount")
SELECT gen_random_uuid(), ob."account_id", ob."id", coa."id", leg."side", leg."amount"
FROM "opening_balances" ob
CROSS JOIN LATERAL (
  VALUES
    ('1000', 'debit',  ob."cash"),
    ('1200', 'debit',  ob."receivables"),
    ('2000', 'credit', ob."payables"),
    ('3000',
      CASE WHEN (ob."cash" + ob."receivables" - ob."payables") >= 0 THEN 'credit' ELSE 'debit' END,
      abs(ob."cash" + ob."receivables" - ob."payables"))
) AS leg("code", "side", "amount")
JOIN "chart_of_accounts" coa
  ON coa."company_id" = ob."company_id" AND coa."code" = leg."code"
WHERE ob."deleted_at" IS NULL AND leg."amount" > 0;
