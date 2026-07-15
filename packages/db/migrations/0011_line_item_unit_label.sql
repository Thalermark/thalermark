-- The collapsed 0000_baseline is a pg_dump that empties the session search_path,
-- and drizzle-kit's generated DDL is unqualified — restore it as the first
-- statement so a fresh-DB session can apply this file (0001–0010 do the same).
SET search_path TO public;--> statement-breakpoint
-- Add a nullable unit-of-measure snapshot to each line-item table (TMC-139) so a
-- picked catalog item's unit ("hour", "sq ft") — or a hand-typed one — rides the
-- line onto the sent/public document next to the quantity. Nullable + no default:
-- existing lines stay null and render a bare quantity exactly as before. A pure
-- ADD COLUMN (no default) takes only a brief metadata lock, no table rewrite.
ALTER TABLE "estimate_line_items" ADD COLUMN "unit_label" text;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD COLUMN "unit_label" text;--> statement-breakpoint
ALTER TABLE "recurring_invoice_line_items" ADD COLUMN "unit_label" text;
