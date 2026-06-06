-- companies.business_address / business_phone — business identity surfaced on
-- invoices and estimates. Both nullable: existing rows and freshly-created
-- companies start null, and the public invoice omits the sender block until
-- they're set. Collected lazily (Settings → Business + a dashboard nudge),
-- never gated at signup, so the <60s first-invoice path stays intact. Adding
-- nullable columns is a safe, non-rewriting change.

ALTER TABLE "companies" ADD COLUMN "business_address" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "business_phone" text;
