ALTER TABLE "invoices" ADD COLUMN "public_token" text;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_public_token_uq" ON "invoices" USING btree ("public_token");