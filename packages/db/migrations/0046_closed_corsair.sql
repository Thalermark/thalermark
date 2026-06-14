ALTER TABLE "companies" ADD COLUMN "show_address_on_estimate" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "show_phone_on_estimate" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "show_email_on_estimate" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN "show_address" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN "show_phone" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN "show_email" boolean DEFAULT true NOT NULL;