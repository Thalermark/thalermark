-- Backfill payment rows for invoices settled before TMC-187 (TMC-194).
--
-- Partial payments made invoice_payments the record of money received, but
-- every invoice already marked paid by the old single-shot mark-paid carries
-- its settlement on the HEADER (paid_at / payment_method / payment_reference /
-- processing_fee) and has no payment rows at all. Those invoices read correctly
-- — the header columns are still written and still read everywhere — but they
-- are stuck in three ways:
--
--   1. They cannot be refunded or corrected. checkPaymentEligibility refuses a
--      payment against a 'paid' invoice with zero rows (that guard is what stops
--      the same cash being banked twice), and void only accepts draft/sent. So
--      an invoice a beta user marked paid can never be adjusted.
--   2. The payments panel shows an empty list on an invoice reading "Paid in
--      full".
--   3. Any check that derives AR as sum(total - paid) over issued invoices
--      disagrees with the ledger: a legacy invoice contributes its full total
--      while the ledger correctly says zero.
--
-- One row per legacy invoice fixes all three, and afterwards the operational
-- tables and the ledger agree for every invoice regardless of when it was paid.
--
-- THIS MUST NOT POST TO THE LEDGER, AND DOES NOT. The original mark-paid
-- already posted the cash (Dr Cash / Cr AR, or Dr Cash / Cr Revenue for the
-- draft-to-paid shortcut). Writing a journal entry here would bank the same
-- money a second time. This is a data-only INSERT: no journal_entries, no
-- journal_lines, and cash on hand is byte-identical before and after. There is
-- a test asserting exactly that.
--
-- Idempotent by the NOT EXISTS guard, so a re-run is a no-op — which matters
-- because the migration runner applies by file hash and a hand-edited file
-- would otherwise re-apply.
SET search_path TO public;--> statement-breakpoint
INSERT INTO invoice_payments (
  id, account_id, company_id, invoice_id,
  amount, received_on, method, reference, processing_fee,
  created_at, updated_at
)
SELECT
  -- v4 rather than v7: Postgres 17 has no uuidv7() builtin, and nothing orders
  -- payments by id (they are read per-invoice by received_on, and this table is
  -- not a paginated list surface), so the time-ordering property is unused here.
  gen_random_uuid(),
  i.account_id,
  i.company_id,
  i.id,
  i.total,
  -- paid_at is timestamptz. The manual mark-paid path stored the user's chosen
  -- date as midnight UTC, so reading it back AT TIME ZONE 'UTC' returns exactly
  -- the date they picked. A session-local ::date would shift it by a day for
  -- anyone west of Greenwich. Falls back to the issue date on the (rare) paid
  -- invoice with no stamp.
  COALESCE((i.paid_at AT TIME ZONE 'UTC')::date, i.issue_date),
  -- method is NOT NULL on invoice_payments. Older rows predate the channel
  -- picker entirely, so 'other' is the honest answer rather than a guess.
  COALESCE(i.payment_method, 'other'),
  i.payment_reference,
  i.processing_fee,
  COALESCE(i.paid_at, now()),
  COALESCE(i.paid_at, now())
FROM invoices i
WHERE i.status = 'paid'
  -- A zero-total invoice has nothing to record, and a zero-amount receipt is
  -- rejected by the API schema for good reason — do not create one here.
  AND i.total > 0
  AND NOT EXISTS (
    SELECT 1 FROM invoice_payments p WHERE p.invoice_id = i.id
  );
