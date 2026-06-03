ALTER TABLE "companies" ADD COLUMN "payment_cash_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "payment_check_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "payment_check_payable_to" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "payment_check_address" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "payment_venmo_handle" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "payment_zelle_contact" text;