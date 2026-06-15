ALTER TABLE "estimate_line_items" ADD COLUMN "type" text DEFAULT 'service' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD COLUMN "type" text DEFAULT 'service' NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "type" text DEFAULT 'service' NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_invoice_line_items" ADD COLUMN "type" text DEFAULT 'service' NOT NULL;