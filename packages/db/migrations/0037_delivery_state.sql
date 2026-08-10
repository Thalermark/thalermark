-- Did the email actually arrive, and did anyone open it (TMC-226, TMC-230).
--
-- `sent_at` has been carrying two meanings that come apart exactly when it
-- matters. It is stamped by the STATUS TRANSITION, not by delivery, and the send
-- route deliberately commits that flip even when the mailer throws — so a
-- hard-bounced invoice reads `sent`, posts to A/R, and gets chased for 45 days.
-- The background senders are worse: recurring generation and reminders both
-- catch the mailer error and log a warning, so a month of auto-billing can
-- deliver nothing at all behind a clean-looking dashboard.
--
-- delivery_status is therefore DISTINCT from status and from sent_at:
--   null        — nothing attempted, or sent before this column existed
--   'sent'      — handed to the mail provider without error
--   'failed'    — the provider refused it; we know immediately, no webhook needed
--   'delivered' — the provider confirmed delivery (webhook, later work)
--   'bounced'   — rejected at the far end (webhook, later work)
--   'complained'— marked as spam (webhook, later work)
--
-- Left as text rather than an enum on purpose: the last three arrive from a
-- provider whose vocabulary is not ours to fix, and a self-host on SMTP will
-- only ever see the first three. An enum would make adding a provider a
-- migration.
--
-- viewed_at answers the other half of "I sent it, I swear" — whether the
-- customer ever opened the public link. Stamped once, on first view.
SET search_path TO public;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "delivery_status" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "delivery_detail" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "delivery_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "viewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN "delivery_status" text;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN "delivery_detail" text;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN "delivery_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN "viewed_at" timestamp with time zone;--> statement-breakpoint
-- The dashboard asks "anything undelivered?" on every load, and the answer is
-- almost always none — a partial index keeps that a lookup rather than a scan,
-- and stays tiny because it only holds the rows that went wrong.
CREATE INDEX "invoices_delivery_trouble_idx" ON "invoices" ("account_id","company_id")
  WHERE "delivery_status" IN ('failed','bounced','complained');
