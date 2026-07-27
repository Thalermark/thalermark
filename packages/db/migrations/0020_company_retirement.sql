-- Company retirement. A business that has stopped trading — most often a sole
-- proprietorship that incorporated, and whose books now belong to a different
-- taxpayer than the one carrying on.
--
-- Deliberately NOT a soft delete. `deleted_at` elsewhere in this schema means
-- "pretend this never happened"; `retired_at` means "this happened, and then
-- ended". The company's books must stay readable and reportable indefinitely —
-- a sole proprietor who incorporates in June still files a final Schedule C for
-- the stub period, potentially years later. So nothing is hidden from reports,
-- nothing cascades, and no row is removed.
--
-- What the column drives, all app-side:
--   * the ledger refuses to post into a retired company (apps/api/src/lib/
--     company-lock.ts, mirroring the period lock)
--   * the company switcher hides retired companies behind a toggle
--
-- Nullable with no default and no backfill: every existing company is active,
-- which is exactly what NULL already means. Pure additive DDL, no rewrite.
SET search_path TO public;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "retired_at" timestamp with time zone;
