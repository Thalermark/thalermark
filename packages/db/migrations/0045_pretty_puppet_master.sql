ALTER TABLE "companies" ADD COLUMN "business_email" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "show_address_on_invoice" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "show_phone_on_invoice" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "show_email_on_invoice" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "show_address" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "show_phone" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "show_email" boolean DEFAULT true NOT NULL;