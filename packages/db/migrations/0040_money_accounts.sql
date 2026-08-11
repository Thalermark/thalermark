-- TMC-207 — a business can have more than one place its money sits.
--
-- Until now every company had exactly one: Cash (1000), seeded at company
-- creation and never joined by another, because nothing in the product creates
-- a chart_of_accounts row. A tradesperson with a business checking account, a
-- cash box and a fuel card had nowhere to say so, and the balance sheet's cash
-- line could never be reconciled against a real statement.
--
-- Two things land here.
--
-- 1. money_account_kind marks WHICH chart rows are somewhere money sits, and
--    what the user calls that place. NULL — nearly every row — means an
--    ordinary ledger account that no money flow may point at.
--
--    A column rather than a numeric-band test, for the same reason
--    PAYABLE_FROM_CODES was an explicit list: inferring the payable-from set
--    from account_type once offered "pay this bill out of Accumulated
--    Depreciation", which posts a BALANCED entry that is nonsense — the one
--    error class a trial-balance check can never catch. A band test would
--    reintroduce that, one renumbering away.
--
--    It also carries the asset/liability split the user never sees: a card is a
--    liability, a checking account is an asset, and both are "where the money
--    went". Deciding which is the system's job, not theirs.
--
-- 2. Four columns recording which account a given money movement used.
--
--    These are COLUMNS and not post-time parameters, which is the load-bearing
--    decision in this migration. Every reversal path in lib/ledger.ts
--    re-derives its lines from the entity row and flips them — none reads the
--    original journal entry back (postCapitalPurchaseReversal,
--    postOwnerMoneyEventReversal, postInvoicePaymentReversal). An account
--    chosen only at create time would therefore be reversed against the
--    DEFAULT: money credited out of the card and debited back into cash, the
--    entry balancing perfectly while being wrong.
--
-- All five columns are nullable with no default, and no transaction table is
-- backfilled. NULL reads as "the primary cash account", which is exactly where
-- every pre-existing row's money actually went — so no historical posting
-- changes meaning, and no row has to be rewritten.
SET search_path TO public;--> statement-breakpoint

ALTER TABLE "capital_purchases" ADD COLUMN "payment_account_id" uuid;--> statement-breakpoint
ALTER TABLE "chart_of_accounts" ADD COLUMN "money_account_kind" text;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD COLUMN "deposit_account_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "deposit_account_id" uuid;--> statement-breakpoint
ALTER TABLE "owner_money_events" ADD COLUMN "money_account_id" uuid;--> statement-breakpoint

ALTER TABLE "capital_purchases" ADD CONSTRAINT "capital_purchases_payment_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("payment_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_deposit_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("deposit_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_deposit_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("deposit_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_money_events" ADD CONSTRAINT "owner_money_events_money_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("money_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- Constrained in the database, not app code only: this drives ledger postings,
-- and a typo'd kind would silently drop an account out of every picker and out
-- of the cash-on-hand read — no error, just a smaller number.
ALTER TABLE "chart_of_accounts" ADD CONSTRAINT "chart_of_accounts_money_account_kind_check"
  CHECK ("money_account_kind" IS NULL OR "money_account_kind" IN ('checking', 'savings', 'cash', 'credit_card'));--> statement-breakpoint

-- The seeded Cash account becomes the primary money account for every existing
-- company. This is the one backfill, and it is what makes NULL resolvable
-- everywhere else: without it there would be no money account to fall back to.
UPDATE "chart_of_accounts" SET "money_account_kind" = 'cash' WHERE "code" = '1000';--> statement-breakpoint

-- Every picker and both cash reads select on this. Partial, because the money
-- accounts are a handful of rows in a chart of ~40 per company.
CREATE INDEX "chart_of_accounts_money_account_kind_idx"
  ON "chart_of_accounts" ("company_id", "money_account_kind")
  WHERE "money_account_kind" IS NOT NULL;
