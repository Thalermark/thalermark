-- Correct the chart-of-accounts tax mappings that point at the wrong IRS line
-- (TMC-167).
--
-- The §179D energy efficient commercial buildings deduction (Form 7205) took a
-- line on Schedule C, Form 1065 and Form 1120-S for tax year 2023, pushing
-- every line below it down one. Our seeds were written before that and never
-- followed, so the "other deductions" catch-all — which carries most of a
-- chart on the partnership and corporate forms, and the miscellaneous tail on
-- Schedule C — has been pointing at the energy line ever since.
--
-- Editing the seed files fixes companies created from here on. It does nothing
-- for companies that already exist: chart_of_accounts.tax_mapping is written
-- once at seed time, and reconcileChartOfAccounts only re-runs when someone
-- CHANGES their business type. Hence this backfill.
--
-- Scoped to the exact old strings rather than to account codes, so a chart
-- someone has hand-edited through the ledger portal is left alone. Idempotent:
-- re-running matches nothing, because the old value no longer exists.
--
-- Form 1120 is deliberately absent. Its line 26 "Other deductions" did not
-- move — the energy line landed on 25, which had been blank since TCJA — so
-- the C-corp mappings were already correct.

SET search_path TO public;--> statement-breakpoint

UPDATE chart_of_accounts
SET tax_mapping = 'Schedule C, Line 27b'
WHERE tax_mapping = 'Schedule C, Line 27a';--> statement-breakpoint

UPDATE chart_of_accounts
SET tax_mapping = 'Form 1065, Line 21'
WHERE tax_mapping = 'Form 1065, Line 20';--> statement-breakpoint

UPDATE chart_of_accounts
SET tax_mapping = 'Form 1120-S, Line 20'
WHERE tax_mapping = 'Form 1120-S, Line 19';
