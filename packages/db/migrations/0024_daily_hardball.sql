ALTER TABLE "companies" ADD COLUMN "stripe_connect_account_id" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "stripe_connect_charges_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "stripe_connect_details_submitted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "companies_stripe_connect_account_id_uq" ON "companies" USING btree ("stripe_connect_account_id");