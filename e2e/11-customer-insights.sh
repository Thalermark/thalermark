#!/usr/bin/env bash
# Customer insights — the contact page's aggregate, walked end to end against a
# live API.
#
# WHY THIS SUITE EXISTS, beyond the integration tests that already cover the
# figures. Those run as a BYPASSRLS superuser against an in-process app, and
# they compare this endpoint to the other endpoints in the same process. What
# they cannot prove is that the numbers a person sees on the contact page are
# the same numbers the rest of the product reports over HTTP, from a real
# session, against a database that has other data in it.
#
# The proofs it is here to produce:
#
#   1. Owed is net of deposits and ties EXACTLY to A/R aging, invoice by
#      invoice. Two screens, one number. The defect class this whole area kept
#      producing — TMC-216, TMC-253, TMC-254 and payment-reliability's own
#      overdueTotal — was always the same shape: sum(total) where the answer was
#      sum(total - paid).
#   2. The median this page states is the median the send-check compares
#      against. If they disagree the feature is worse than nothing, and only a
#      cross-endpoint check can see it.
#   3. Billed is PRE-TAX while owed is GROSS. The customer owes the sales tax;
#      the operator never earned it.
#   4. A lapsed estimate stays out of the accept rate and is counted on its own.
#   5. A customer with one invoice gets the strip and nothing else — every
#      analytic block has a floor, and the floors are the design.
#
# Point at a throwaway stack with TMC_API / TMC_PG (see lib.sh).
source "$(dirname "$0")/lib.sh"

EMAIL="e2e-insights-$(date +%s)@example.com"
signup "$EMAIL" || exit 1
CO=$(newco "Insights E2E" "sole_prop")
CT=$(api POST /api/contacts \
  "{\"companyId\":\"$CO\",\"name\":\"Ridgeline Homes\",\"email\":\"ap@ridgeline.example\"}" | jq -r '.id')

mkinvoice() { # mkinvoice <number> <subtotal> <tax> <issueDate> <dueDate> -> prints id
  local total
  total=$(printf '%.2f' "$(echo "$2 + $3" | bc)")
  api POST /api/invoices \
    "{\"companyId\":\"$CO\",\"contactId\":\"$CT\",\"number\":\"$1\",\"issueDate\":\"$4\",\"dueDate\":\"$5\",\"subtotal\":\"$2\",\"tax\":\"$3\",\"total\":\"$total\",\"lineItems\":[{\"position\":1,\"description\":\"Mowing\",\"quantity\":\"1\",\"unitPrice\":\"$2\",\"amount\":\"$2\",\"type\":\"service\"}]}" |
    jq -r '.id'
}
issue() { status POST "/api/invoices/$1/mark-sent" '{}'; }
pay() { # pay <invoiceId> <amount> <receivedOn>
  api POST "/api/invoices/$1/payments" \
    "{\"amount\":\"$2\",\"receivedOn\":\"$3\",\"method\":\"check\"}" >/dev/null
}
insights() { api GET "/api/contacts/$CT/insights"; }

# Dates relative to today, so the suite does not rot: the twelve-month window
# and the overdue test both move with the calendar.
ago() { date -u -v-"$1"m +%Y-%m-01 2>/dev/null || date -u -d "$1 months ago" +%Y-%m-01; }

# ── 1. Owed, against A/R aging ────────────────────────────────────────────────
section "What they owe, agreed by two screens"

A=$(mkinvoice "INS-1" "1000.00" "0.00" "$(ago 3)" "$(ago 3)")
check "the first invoice is issued" "$(issue "$A")" "200"
pay "$A" "400.00" "$(ago 2)"

B=$(mkinvoice "INS-2" "250.00" "0.00" "$(ago 2)" "$(ago 2)")
issue "$B" >/dev/null

# Settled in full — it must contribute to neither figure.
C=$(mkinvoice "INS-3" "80.00" "0.00" "$(ago 1)" "$(ago 1)")
issue "$C" >/dev/null
pay "$C" "80.00" "$(ago 1)"

INS=$(insights)
check "owed is net of the deposit" "$(echo "$INS" | jq -r '.owed.amount')" "850.00"

# Compared as integer CENTS on both sides. Money crosses the API as a decimal
# string and jq's tostring drops trailing zeros, so "850.00" and "850" are the
# same amount and different strings — a comparison that would fail on formatting
# while the books agree perfectly.
AGING=$(api GET "/api/companies/$CO/ar-aging" |
  jq -r '[.invoices[].amount | tonumber * 100 | round] | add // 0')
OWED=$(echo "$INS" | jq -r '.owed.amount | tonumber * 100 | round')
check "A/R aging says the same number" "$AGING" "$OWED"

# Both invoices are past due — the aging report and this page must also agree on
# the overdue slice, which is where payment-reliability used to report gross.
check "overdue counts two" "$(echo "$INS" | jq -r '.owed.overdueCount')" "2"
check "overdue is net too" "$(echo "$INS" | jq -r '.owed.overdueAmount')" "850.00"
check "the old endpoint agrees" \
  "$(api GET "/api/contacts/$CT/payment-reliability" | jq -r '.overdueTotal')" "850.00"

# ── 2. The median, against the send-check ─────────────────────────────────────
section "What you usually bill them"

# Three issued invoices: 1000, 250, 80 → median 250.
check "the page states the median" "$(echo "$INS" | jq -r '.typical.median')" "250.00"

# A draft far above that habit. It is excluded from both sets while it is a
# draft, which is exactly why the two agree at the only moment it matters.
D=$(mkinvoice "INS-BIG" "5000.00" "0.00" "$(ago 0)" "$(ago 0)")
CHECK=$(api GET "/api/invoices/$D/send-check")
check "the send-check fires on the median" "$(echo "$CHECK" | jq -r '.signal')" "median"
MED=$(echo "$INS" | jq -r '.typical.median')
if echo "$CHECK" | jq -r '.concern' | grep -q "\$$(echo "$MED" | sed 's/\..*//')"; then
  ok "the warning quotes the same figure the page shows"
else
  bad "the warning quotes the same figure the page shows" \
    "page said $MED, warning said: $(echo "$CHECK" | jq -r '.concern')"
fi

# ── 3. Pre-tax earned, gross owed ─────────────────────────────────────────────
section "Billed pre-tax, owed gross"

T=$(mkinvoice "INS-TAX" "500.00" "40.00" "$(ago 1)" "$(ago 1)")
issue "$T" >/dev/null
INS=$(insights)
# 1000 + 250 + 80 + 500 of work. The 40.00 of sales tax was never income.
check "billed is the work only" "$(echo "$INS" | jq -r '.billed.allTime')" "1830.00"
# ...but the customer owes it: 850 from before + 540 gross.
check "owed includes the tax" "$(echo "$INS" | jq -r '.owed.amount')" "1390.00"

# ── 4. Estimates — lapsed is not a decision ───────────────────────────────────
section "Estimates"

mkest() { # mkest <number> <expiresOn> -> prints id
  api POST /api/estimates \
    "{\"companyId\":\"$CO\",\"contactId\":\"$CT\",\"number\":\"$1\",\"issueDate\":\"2026-01-10\",\"expiresOn\":\"$2\",\"subtotal\":\"100.00\",\"tax\":\"0.00\",\"total\":\"100.00\",\"lineItems\":[{\"position\":1,\"description\":\"Quote\",\"quantity\":\"1\",\"unitPrice\":\"100.00\",\"amount\":\"100.00\"}]}" |
    jq -r '.id'
}
E1=$(mkest "EST-1" "2026-02-10"); status POST "/api/estimates/$E1/mark-sent" '{}' >/dev/null
status POST "/api/estimates/$E1/mark-accepted" '{}' >/dev/null
E2=$(mkest "EST-2" "2026-02-10"); status POST "/api/estimates/$E2/mark-sent" '{}' >/dev/null
status POST "/api/estimates/$E2/mark-declined" '{}' >/dev/null
# Sent, expiry long past, never answered. NOT a "no" — the customer said
# nothing, and the expiry date was the operator's own choice.
E3=$(mkest "EST-3" "2026-02-01"); status POST "/api/estimates/$E3/mark-sent" '{}' >/dev/null
# Sent and still live.
E4=$(mkest "EST-4" "2099-01-01"); status POST "/api/estimates/$E4/mark-sent" '{}' >/dev/null

EST=$(insights | jq -c '.estimates')
check "answered counts only the two that replied" "$(echo "$EST" | jq -r '.answered')" "2"
check "accepted is one of them" "$(echo "$EST" | jq -r '.accepted')" "1"
check "the lapsed quote is counted on its own" "$(echo "$EST" | jq -r '.lapsed')" "1"
check "the live quote is still open" "$(echo "$EST" | jq -r '.open')" "1"

# ── 5. The floors ─────────────────────────────────────────────────────────────
section "A customer with almost no history"

THIN=$(api POST /api/contacts \
  "{\"companyId\":\"$CO\",\"name\":\"One Job Only\"}" | jq -r '.id')
T1=$(api POST /api/invoices \
  "{\"companyId\":\"$CO\",\"contactId\":\"$THIN\",\"number\":\"INS-THIN\",\"issueDate\":\"$(ago 1)\",\"dueDate\":\"$(ago 1)\",\"subtotal\":\"120.00\",\"tax\":\"0.00\",\"total\":\"120.00\",\"lineItems\":[{\"position\":1,\"description\":\"Mowing\",\"quantity\":\"1\",\"unitPrice\":\"120.00\",\"amount\":\"120.00\",\"type\":\"service\"}]}" |
  jq -r '.id')
issue "$T1" >/dev/null

THIN_INS=$(api GET "/api/contacts/$THIN/insights")
# The strip renders — a count of one and a real balance are both honest.
check "the strip has something to say" "$(echo "$THIN_INS" | jq -r '.billed.invoiceCount')" "1"
check "and a real balance" "$(echo "$THIN_INS" | jq -r '.owed.amount')" "120.00"
# Everything analytic is beneath its floor. One invoice is not a habit, one
# month is not a trend, and no estimate is not a rate.
check "no habit to state" "$(echo "$THIN_INS" | jq -r '.typical.recent | length')" "1"
check "one month only" "$(echo "$THIN_INS" | jq -r '.months | length')" "1"
check "nothing was ever quoted" "$(echo "$THIN_INS" | jq -r '.estimates.answered')" "0"

# A contact with no invoices at all answers with zeros, not a 404 — the page
# still has a name, an address and a history tab to render.
EMPTY=$(api POST /api/contacts "{\"companyId\":\"$CO\",\"name\":\"Never Billed\"}" | jq -r '.id')
EMPTY_INS=$(api GET "/api/contacts/$EMPTY/insights")
check "an unbilled contact is not an error" "$(echo "$EMPTY_INS" | jq -r '.billed.invoiceCount')" "0"
check "with no median to state" "$(echo "$EMPTY_INS" | jq -r '.typical.median')" "null"

summary "11-customer-insights"
