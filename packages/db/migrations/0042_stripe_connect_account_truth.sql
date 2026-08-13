-- TMC-256 / TMC-257 — telling the owner whose turn it is, and noticing when we
-- stopped knowing.
--
-- The connected account was mirrored as two booleans: details_submitted and
-- charges_enabled. That makes "submitted but not charging" a single state in
-- our model when Stripe means at least three by it — they are verifying, they
-- are blocked on the OWNER, or they rejected the account outright. The page
-- told all three to sit tight and wait for an email. For two of them that is
-- the opposite of what the owner needs to hear.
--
-- payouts_enabled is the same shape and was equally invisible: an Express
-- account can take charges while payouts are held, so customers pay, the money
-- never lands, and the page reads "Payments are live."
--
-- requirements_due is a boolean and not the field list on purpose. Stripe's own
-- onboarding page already renders the checklist, and the Continue button drops
-- the owner straight onto it. Storing the list would owe a translation of names
-- like individual.verification.document into English, maintained against
-- Stripe's changes forever, to duplicate a screen they render better. Our job
-- is only to stop claiming nothing is needed when something is.
--
-- synced_at is the second half (TMC-257). These flags had exactly one writer,
-- the account.updated webhook, and the status route reads them without ever
-- asking Stripe. So one missed delivery drifted a company permanently: the
-- webhook's no-op guard returns early when the booleans already match, which is
-- right for idempotency but means only a CHANGED event can repair a stale row,
-- and nothing ever triggers one. Recording when we last heard the truth lets
-- the read path re-ask Stripe when the answer is both stale and consequential,
-- without turning every page load into a Stripe call.
--
-- Defaults match what every existing row already is: no company is payouts-
-- enabled or blocked until Stripe says so, and synced_at is null for every row
-- written before this migration, which is exactly true — we had never recorded
-- it. Hand-authored rather than generated, following 0039: the drizzle snapshot
-- has drifted behind the hand-authored migrations and `generate` re-emits their
-- columns.
SET search_path TO public;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "stripe_connect_payouts_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "stripe_connect_requirements_due" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "stripe_connect_disabled_reason" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "stripe_connect_synced_at" timestamp with time zone;
