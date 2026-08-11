#!/usr/bin/env bash
# TMC-227 — correcting an invoice the customer already has, walked end to end
# against a live API.
#
# WHY THIS SUITE EXISTS, beyond the integration tests that already cover the
# same flow. Those run as a BYPASSRLS superuser against an in-process app; this
# runs over HTTP as a real session, and — for the customer-facing half — with no
# session at all. A page authorized by a URL token has to be asserted WITHOUT a
# cookie or it is not being asserted (the rule 09-public-pay.sh encodes).
#
# The four proofs it is here to produce, none of which a unit test can give:
#
#   1. A part-paid invoice corrected from $450 to $500, with $200 already
#      banked, reports $300 outstanding. Not $450, not $250, not $50.
#   2. Revenue moves by exactly the correction, in the right period — reversal
#      at the original issue date, re-post at the corrected one.
#   3. The customer's ORIGINAL link, never re-minted, shows "being revised" with
#      no way to pay mid-correction, and afterwards the corrected amount plus an
#      honest note about what it used to be.
#   4. Two full corrections that change nothing leave every account exactly
#      where it started. This is the reverse-re-derives trap — the one the
#      previous attempt at this feature most likely died in — and a trial
#      balance of zero cannot see it.
#
# Point at a throwaway stack with TMC_API / TMC_PG (see lib.sh).
source "$(dirname "$0")/lib.sh"

# Anonymous — no cookie at all, exactly like the recipient opening the link out
# of an email. Reaching for `api` here would silently re-authenticate and every
# assertion below would go green while proving nothing.
anon_api() { curl -s "$API$1"; }

# Signed balance on one chart code (debits − credits) for the company under
# test, straight out of the journal. The API has no endpoint that exposes this,
# and going through psql is the point: it is the books themselves, not a report
# that could agree with a wrong posting.
bal() { # bal <code>
  psql_q "select coalesce(sum(case when jl.side = 'debit' then jl.amount else -jl.amount end), 0)::numeric(15,2)
          from journal_lines jl
          join journal_entries je on je.id = jl.journal_entry_id
          join chart_of_accounts coa on coa.id = jl.coa_account_id
          where je.company_id = '$CO' and coa.code = '$1';"
}

trial_balance() {
  psql_q "select coalesce(sum(case when jl.side = 'debit' then jl.amount else -jl.amount end), 0)::numeric(15,2)
          from journal_lines jl
          join journal_entries je on je.id = jl.journal_entry_id
          where je.company_id = '$CO';"
}

# The dates every entry for one invoice landed on, oldest first, comma-joined.
# Which PERIOD a correction posted in is the assertion; that it balanced is not.
entry_dates() { # entry_dates <invoiceId>
  psql_q "select string_agg(to_char(posted_at at time zone 'UTC', 'YYYY-MM-DD'), ',' order by posted_at, id)
          from journal_entries where source_entity_id = '$1';"
}

EMAIL="e2e-fix-$(date +%s)@example.com"
signup "$EMAIL" || exit 1
CO=$(newco "Fix Invoice E2E" "sole_prop")
CT=$(api POST /api/contacts \
  "{\"companyId\":\"$CO\",\"name\":\"Mrs Patel\",\"email\":\"patel@example.com\"}" | jq -r '.id')

mkinvoice() { # mkinvoice <number> <total> <issueDate> <dueDate> -> prints id
  api POST /api/invoices \
    "{\"companyId\":\"$CO\",\"contactId\":\"$CT\",\"number\":\"$1\",\"issueDate\":\"$3\",\"dueDate\":\"$4\",\"subtotal\":\"$2\",\"tax\":\"0.00\",\"total\":\"$2\",\"lineItems\":[{\"position\":1,\"description\":\"Mowing\",\"quantity\":\"1\",\"unitPrice\":\"$2\",\"amount\":\"$2\",\"type\":\"service\"}]}" |
    jq -r '.id'
}

edit_total() { # edit_total <id> <number> <total> <issueDate> <dueDate> -> prints status
  status PATCH "/api/invoices/$1" \
    "{\"contactId\":\"$CT\",\"number\":\"$2\",\"issueDate\":\"$4\",\"dueDate\":\"$5\",\"subtotal\":\"$3\",\"tax\":\"0.00\",\"total\":\"$3\",\"lineItems\":[{\"position\":1,\"description\":\"Mowing\",\"quantity\":\"1\",\"unitPrice\":\"$3\",\"amount\":\"$3\",\"type\":\"service\"}]}"
}

# mark-sent, not /send, throughout. Both flip draft → sent through the same
# transition and post the same ledger entry; /send additionally hands the mail
# to a provider, and the dev mailer 502s on any address outside its allowlist.
# The email copy is covered by the integration suite; the books are what this
# file is for.
issue() { status POST "/api/invoices/$1/mark-sent" '{}'; }

# ── 1. The part-paid correction ───────────────────────────────────────────────
section "A part-paid invoice, corrected"

NUM="INV-FIX-$(date +%s)"
INV=$(mkinvoice "$NUM" "450.00" "2026-06-10" "2026-07-10")
check "the invoice is issued" "$(issue "$INV")" "200"
check "AR carries the full amount" "$(bal 1200)" "450.00"

api POST "/api/invoices/$INV/payments" \
  '{"amount":"200.00","receivedOn":"2026-06-15","method":"check"}' >/dev/null
check "a deposit lands" "$(api GET "/api/invoices/$INV/payments" | jq -r '.paid')" "200.00"

TOKEN=$(psql_q "select public_token from invoices where id = '$INV';")
[ -n "$TOKEN" ] && ok "the customer has a link" || bad "the customer has a link"

check "pulling it back is accepted" "$(status POST "/api/invoices/$INV/revise" '{}')" "200"
# The receivable is gone in full — including the part already relieved by the
# deposit, which stays on the books as cash against a now-negative AR until the
# resend puts the receivable back. Nothing has vanished; it nets out below.
check "the receivable comes off" "$(bal 1200)" "-200.00"
check "the revenue comes off" "$(bal 4000)" "0.00"
check "the books still balance" "$(trial_balance)" "0.00"

# ── 2. What the recipient sees, with no session ───────────────────────────────
section "The old link, mid-correction"

PUB=$(anon_api "/api/public/invoices/$TOKEN")
check "the page says it is being revised" "$(echo "$PUB" | jq -r '.beingRevised')" "true"
check "the card path is closed" "$(echo "$PUB" | jq -r '.payable')" "false"
check "the offline instructions are gone" "$(echo "$PUB" | jq -r '.offlinePayment')" "null"
# The one thing that must never happen: a stale amount the customer can still
# act on. Asserted as "not 200" rather than a specific code, because a stack
# without Stripe configured refuses at a different gate (503 vs 409) and the
# refusal is what matters, not which guard got there first.
MINT=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/public/invoices/$TOKEN/payment-intent")
if [ "$MINT" = "200" ]; then
  bad "the intent mint refuses" "got 200 — the stale amount is chargeable"
else
  ok "the intent mint refuses (HTTP $MINT)"
fi

# ── 3. Correct it and resend ──────────────────────────────────────────────────
section "Corrected and resent"

check "the draft is editable again" "$(edit_total "$INV" "$NUM" "500.00" "2026-06-10" "2026-07-10")" "200"
check "the correction is re-issued" "$(issue "$INV")" "200"

SETTLE=$(api GET "/api/invoices/$INV/payments")
# THE proof. $300, not $450 (ignoring the deposit), not $250 (subtracting from
# the old total), not $50 (subtracting the correction).
check "outstanding is the corrected balance" "$(echo "$SETTLE" | jq -r '.outstanding')" "300.00"
check "the deposit never moved" "$(echo "$SETTLE" | jq -r '.paid')" "200.00"
check "the receipt was not duplicated" "$(echo "$SETTLE" | jq -r '.payments | length')" "1"
check "settlement reads partial" "$(echo "$SETTLE" | jq -r '.settlement')" "partial"

check "AR carries the corrected balance" "$(bal 1200)" "300.00"
check "revenue moved by exactly the correction" "$(bal 4000)" "-500.00"
check "the books still balance" "$(trial_balance)" "0.00"

PUB2=$(anon_api "/api/public/invoices/$TOKEN")
# The SAME url. The token is minted once and never re-minted, so the link
# already sitting in the customer's inbox is the one that resolves.
check "the old link still resolves" "$(echo "$PUB2" | jq -r '.number')" "$NUM"
check "it is no longer being revised" "$(echo "$PUB2" | jq -r '.beingRevised')" "false"
check "it shows the corrected amount" "$(echo "$PUB2" | jq -r '.total')" "500.00"
check "it says what the total used to be" \
  "$(echo "$PUB2" | jq -r '.revisions[0].previousTotal')" "450.00"
check "the invoice number never changed" \
  "$(psql_q "select number from invoices where id = '$INV';")" "$NUM"

# ── 4. The guards ─────────────────────────────────────────────────────────────
section "What it refuses"

check "a draft that was never issued" \
  "$(status POST "/api/invoices/$(mkinvoice "INV-NEVER-$(date +%s)" "10.00" 2026-06-10 2026-07-10)/revise" '{}')" \
  "409"

PAID=$(mkinvoice "INV-PAID-$(date +%s)" "80.00" "2026-06-10" "2026-07-10")
issue "$PAID" >/dev/null
api POST "/api/invoices/$PAID/mark-paid" '{"method":"cash","paidOn":"2026-06-12"}' >/dev/null
PAID_ERR=$(api POST "/api/invoices/$PAID/revise" '{}' | jq -r '.error')
check "a paid invoice, with the way out named" "$PAID_ERR" "invoice_paid"

# The corruption path with no status guard before this change: removing a
# receipt mid-correction ran syncInvoiceSettlement, whose unpaid branch returns
# 'sent' for an issued invoice — flipping the row back to sent with no revenue
# posting behind it, uneditable and unsendable, permanently off the books.
GUARD=$(mkinvoice "INV-GUARD-$(date +%s)" "300.00" "2026-06-10" "2026-07-10")
issue "$GUARD" >/dev/null
PAY_ID=$(api POST "/api/invoices/$GUARD/payments" \
  '{"amount":"100.00","receivedOn":"2026-06-15","method":"cash"}' | jq -r '.payment.id')
api POST "/api/invoices/$GUARD/revise" '{}' >/dev/null
DEL_ERR=$(api DELETE "/api/invoices/$GUARD/payments/$PAY_ID" | jq -r '.error')
check "removing a payment mid-correction" "$DEL_ERR" "revision_in_progress"
check "and the invoice is still a draft" \
  "$(psql_q "select status from invoices where id = '$GUARD';")" "draft"

MP_ERR=$(api POST "/api/invoices/$GUARD/mark-paid" '{"method":"cash"}' | jq -r '.error')
check "marking a revising draft paid" "$MP_ERR" "revision_in_progress"

# ── 5. The issue date follows the correction ─────────────────────────────────
section "A corrected issue date moves the period"

DNUM="INV-DATE-$(date +%s)"
DATED=$(mkinvoice "$DNUM" "600.00" "2026-02-03" "2026-03-03")
issue "$DATED" >/dev/null
api POST "/api/invoices/$DATED/revise" '{}' >/dev/null
edit_total "$DATED" "$DNUM" "600.00" "2026-03-09" "2026-04-09" >/dev/null
issue "$DATED" >/dev/null
# Issue and its reversal both in February — that month nets to zero — and the
# re-issue in March, where the invoice now says it belongs. Post it all at
# `now` instead and a correction across a year end moves income onto the wrong
# return.
check "reversal in the old period, re-post in the new" \
  "$(entry_dates "$DATED")" "2026-02-03,2026-02-03,2026-03-09"

# ── 6. Two corrections that changed nothing ──────────────────────────────────
section "The books return to baseline"

BNUM="INV-BASE-$(date +%s)"
BASE=$(mkinvoice "$BNUM" "725.00" "2026-06-10" "2026-07-10")
issue "$BASE" >/dev/null
AR_BEFORE=$(bal 1200)
REV_BEFORE=$(bal 4000)

for _ in 1 2; do
  api POST "/api/invoices/$BASE/revise" '{}' >/dev/null
  edit_total "$BASE" "$BNUM" "725.00" "2026-06-10" "2026-07-10" >/dev/null
  issue "$BASE" >/dev/null
done

# The reverse-re-derives check. It passes by construction — the reversal always
# runs against the row values it is reversing, because pulling back happens
# BEFORE the edit — and it is asserted anyway, because that ordering is exactly
# what a later refactor would quietly break.
check "AR is back where it started" "$(bal 1200)" "$AR_BEFORE"
check "revenue is back where it started" "$(bal 4000)" "$REV_BEFORE"
check "the books still balance" "$(trial_balance)" "0.00"
check "both corrections were recorded" \
  "$(psql_q "select count(*) from invoice_revisions where invoice_id = '$BASE';")" "2"

# ── 7. A closed year is refused ──────────────────────────────────────────────
section "A closed year"

CNUM="INV-CLOSED-$(date +%s)"
CLOSED=$(mkinvoice "$CNUM" "150.00" "2025-06-10" "2025-07-10")
issue "$CLOSED" >/dev/null
api POST /api/ledger/period-closes "{\"companyId\":\"$CO\",\"fiscalYear\":2025}" >/dev/null
CLOSED_ERR=$(api POST "/api/invoices/$CLOSED/revise" '{}' | jq -r '.error')
check "correcting a filed year is refused" "$CLOSED_ERR" "period_closed"
# Refused BEFORE any write, not rolled back after one. The row is untouched and
# no correction was recorded.
check "and the invoice is untouched" \
  "$(psql_q "select status from invoices where id = '$CLOSED';")" "sent"
check "with nothing recorded against it" \
  "$(psql_q "select count(*) from invoice_revisions where invoice_id = '$CLOSED';")" "0"

summary "10-fix-invoice"
