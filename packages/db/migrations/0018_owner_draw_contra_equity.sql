-- Owner's Draw (3100) is a contra-EQUITY account and was seeded with the wrong
-- normal_balance. Pure data backfill, no DDL.
--
-- The balance-sheet code (routes/reports.ts) nets every account in its
-- normal_balance direction. A draw posts Dr 3100; with normal_balance 'debit'
-- that MATCHED, so it came out positive and *increased* reported equity. Net
-- effect: any company that had ever recorded a draw, a shareholder distribution
-- or a dividend reported balanced=false on its balance sheet, with total equity
-- overstated by twice the withdrawals.
--
-- 'credit' is the fix, and it is the same trick 0003 used for 1900 Accumulated
-- Depreciation in the other direction: normal_balance is the direction the
-- report nets in, not the side the account really carries. Netting a debit
-- posting against a 'credit' normal yields a NEGATIVE figure, so withdrawals
-- reduce equity and Assets = Liabilities + Equity holds with no contra-account
-- special-casing.
--
-- The GL / trial-balance export reads the actual posting `side`, so it was
-- always right and is unaffected here. No journal_lines are touched: the
-- postings were correct all along, only the display direction was wrong.
--
-- Scoped to code '3100' across every company and entity type (the entity
-- overlays only rename this account — Partners' Draws / Shareholder
-- Distributions / Dividends Paid — so all of them carry the same wrong value).
-- Idempotent: re-running matches nothing once the value is already 'credit'.
SET search_path TO public;--> statement-breakpoint
UPDATE "chart_of_accounts"
SET "normal_balance" = 'credit'
WHERE "code" = '3100' AND "normal_balance" = 'debit';
