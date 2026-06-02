-- companies.reply_to_email — slice 8.16. Customer-facing reply address for a
-- company's outbound invoice/estimate emails. When set, those emails carry a
-- Reply-To pointing here so a customer's reply reaches the business, not the
-- platform sender. Nullable: null means no Reply-To header (the prior
-- behaviour), so existing rows keep working untouched. The From envelope
-- address still stays on the DNS-verified EMAIL_FROM domain — only the From
-- display name is swapped to the company name in the app layer.

ALTER TABLE "companies" ADD COLUMN "reply_to_email" text;
