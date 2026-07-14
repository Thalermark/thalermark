-- squawk-ignore-file changing-column-type
-- changing-column-type is kept ON globally (a universally-destructive guard),
-- but this specific widening is reviewed and safe, so it's ignored for this file
-- only (TMC-134): the three line-item tables are tiny in early beta so the
-- ACCESS EXCLUSIVE rewrite is momentary; numeric(15,2) → (15,4) is a widening
-- that preserves existing values; and readers just get a wider decimal string,
-- which formatUnitPrice() renders cleanly (no client breakage).
--
-- The collapsed 0000_baseline is a pg_dump that empties the session search_path,
-- and drizzle-kit's generated DDL is unqualified — restore it as the first
-- statement so a fresh-DB session can apply this file (0001–0009 do the same).
SET search_path TO public;--> statement-breakpoint
-- Widen line-item unit_price from numeric(15,2) to numeric(15,4) so a line total
-- that doesn't divide evenly by the quantity can be represented exactly (TMC-134;
-- e.g. $650 over 7 units → $92.8571/unit). A safe widening — existing 2dp values
-- are preserved (gaining trailing zeros); `amount` stays numeric(15,2).
ALTER TABLE "estimate_line_items" ALTER COLUMN "unit_price" SET DATA TYPE numeric(15, 4);--> statement-breakpoint
ALTER TABLE "invoice_line_items" ALTER COLUMN "unit_price" SET DATA TYPE numeric(15, 4);--> statement-breakpoint
ALTER TABLE "recurring_invoice_line_items" ALTER COLUMN "unit_price" SET DATA TYPE numeric(15, 4);
