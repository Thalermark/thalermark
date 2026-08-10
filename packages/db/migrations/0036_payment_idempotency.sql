-- Double-click protection for manually recorded payments (TMC-218).
--
-- The Stripe path has had an idempotency guarantee since partial payments
-- shipped: invoice_payments_stripe_intent_uq turns a repeated webhook delivery
-- into a no-op instead of crediting the customer twice. The manual path — a
-- person clicking "Record payment" — had nothing. The button showed no pending
-- state, so a slow request read as a dead click and invited a second one, and
-- two identical receipts is a silent books error: an invoice that reports
-- itself overpaid, with the cash on the books twice.
--
-- Disabling the button is not on its own a fix. Two tabs, a back-button
-- resubmit and a network retry all reach the same place without a second
-- click, which is why the guarantee has to live here.
--
-- Nullable and partial, exactly like the Stripe index it mirrors: every row
-- written before this column existed, and every Stripe row, leaves it null, and
-- nulls must not collide with one another. Scoped to account_id so one tenant's
-- key can never collide with another's.
--
-- The client mints the key per form render, which is what makes this correct
-- rather than merely deduplicating: retrying the SAME submission is a no-op,
-- while two genuine $50 cash instalments on the same day carry different keys
-- and are both recorded.
SET search_path TO public;--> statement-breakpoint
ALTER TABLE "bill_payments" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "bill_payments_idempotency_uq" ON "bill_payments" USING btree ("account_id","idempotency_key") WHERE "bill_payments"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_payments_idempotency_uq" ON "invoice_payments" USING btree ("account_id","idempotency_key") WHERE "invoice_payments"."idempotency_key" is not null;
