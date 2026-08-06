-- The invoice line's link back to the tracked time entry it bills (TMC-180).
--
-- Until now the link ran ONE WAY: time_entries.billed_invoice_id. An invoice
-- line had no way back to its entry, and two problems fell out of that same
-- missing edge:
--
--   1. Deleting a saved hour line stranded its entry as billed forever — never
--      listed as unbilled, never billable again.
--   2. The edit form had to ship the already-billed ids as hidden fields,
--      because it could not rebuild the set from its own rows, and
--      billedTimeEntryIds replaces on write.
--
-- With this column THE LINE is the single source of truth for what an invoice
-- bills. Delete the line and the link goes with it.
--
-- SET NULL, not cascade: deleting a time entry must never delete an invoice line
-- the customer was already billed for. Deleting a BILLED entry is refused
-- anyway; this covers the void-then-delete path.
SET search_path TO public;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD COLUMN "time_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_time_entry_id_time_entries_id_fk" FOREIGN KEY ("time_entry_id") REFERENCES "public"."time_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_line_items_time_entry_id_idx" ON "invoice_line_items" USING btree ("time_entry_id");