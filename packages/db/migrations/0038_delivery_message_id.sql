-- The provider's id for the message we sent, so its webhook can find the row
-- (TMC-226).
--
-- A delivery webhook arrives with no tenant context and no invoice id — the
-- signature is the authorization, and the only thing tying the event to a
-- document is the id the provider handed back when it accepted the send. So we
-- have to keep it. Without this column, `email.bounced` is an event we can
-- verify and then cannot act on.
--
-- Nullable and no unique constraint, deliberately:
--   - null for every row sent before this column existed, and for every send
--     through a driver that returns no id (the console driver, and SMTP when
--     it lands — nodemailer's messageId is generated locally and no webhook
--     will ever quote it back).
--   - not unique because re-sending a document overwrites this with the newest
--     attempt, and a provider is free to reuse or recycle ids in ways that are
--     not ours to enforce. The lookup takes the newest match; a late event for
--     a superseded attempt is discarded by the created_at ordering guard in
--     applyProviderEvent, not by the schema.
SET search_path TO public;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "delivery_message_id" text;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN "delivery_message_id" text;--> statement-breakpoint
-- Every webhook delivery is one lookup by this value, on a table where almost
-- every row is something else. Partial so it holds only rows actually sent
-- through a provider that reports back.
CREATE INDEX "invoices_delivery_message_id_idx" ON "invoices" ("delivery_message_id")
  WHERE "delivery_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "estimates_delivery_message_id_idx" ON "estimates" ("delivery_message_id")
  WHERE "delivery_message_id" IS NOT NULL;
