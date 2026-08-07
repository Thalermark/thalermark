#!/usr/bin/env bash
# The two locks this arc added: the year-end close (a year you've filed can't be
# quietly re-written) and company retirement (a business that stopped trading
# takes no new work, but can still bank the cheques it already sent).
source "$(dirname "$0")/lib.sh"

EMAIL="e2e-locks-$(date +%s)@example.com"
signup "$EMAIL" || exit 1

CID=$(newco "Locks Landscaping" "sole_prop")
CASH=$(coa "$CID" 1000)
FUEL=$(coa "$CID" 6200)

expense() { # expense <amount> <date>
  status POST /api/expenses \
    "{\"companyId\":\"$CID\",\"categoryAccountId\":\"$FUEL\",\"paymentAccountId\":\"$CASH\",\"amount\":\"$1\",\"expenseDate\":\"$2\",\"merchant\":\"Fuel\"}"
}

section "Year-end close"
api POST /api/owner-money "{\"companyId\":\"$CID\",\"kind\":\"contribution\",\"amount\":\"20000.00\",\"occurredOn\":\"2024-01-05\"}" >/dev/null
check "an expense in 2024 posts" "$(expense 500.00 2024-06-01)" "201"
check "an expense in 2025 posts" "$(expense 300.00 2025-06-01)" "201"

PL24=$(api GET "/api/companies/$CID/profit-loss?from=2024-01-01&to=2024-12-31" | jq -r '.totalExpenses')
check "2024 P&L shows the year's trading" "$PL24" "500.00"

PREVIEW=$(api GET "/api/ledger/period-closes/preview?companyId=$CID&fiscalYear=2024")
echo "      preview: $(echo "$PREVIEW" | jq -c '{netIncome, lines: (.lines|length)}' 2>/dev/null || echo "$PREVIEW" | head -c 200)"

CLOSE=$(api POST /api/ledger/period-closes "{\"companyId\":\"$CID\",\"fiscalYear\":2024}")
CLOSE_ID=$(echo "$CLOSE" | jq -r '.id')
if [ -n "$CLOSE_ID" ] && [ "$CLOSE_ID" != "null" ]; then ok "2024 closes"; else
  bad "2024 closes" "$(echo "$CLOSE" | head -c 200)"
fi

# The close moves the year's profit into equity, so the P&L for a CLOSED year
# must still report what was traded — it's what the return was filed from.
PL24_AFTER=$(api GET "/api/companies/$CID/profit-loss?from=2024-01-01&to=2024-12-31" | jq -r '.totalExpenses')
check "a closed year still reports its P&L" "$PL24_AFTER" "500.00"
check "the sheet still balances after closing" \
  "$(api GET "/api/companies/$CID/balance-sheet?asOf=2024-12-31" | jq -r '.balanced')" "true"

check "posting INTO the closed year is refused" "$(expense 99.00 2024-08-01)" "409"
check "posting after the closed year still works" "$(expense 120.00 2025-08-01)" "201"

REOPEN=$(api POST "/api/ledger/period-closes/$CLOSE_ID/reopen" '{}')
check "the year reopens" "$(echo "$REOPEN" | jq -r '.reopened')" "true"
check "posting into a reopened year works again" "$(expense 99.00 2024-08-01)" "201"

section "Company retirement"
CONTACT=$(api POST /api/contacts "{\"companyId\":\"$CID\",\"name\":\"Mrs Patel\"}" | jq -r '.id')
INV=$(api POST /api/invoices "{\"companyId\":\"$CID\",\"contactId\":\"$CONTACT\",\"number\":\"INV-1\",\"issueDate\":\"2026-05-01\",\"dueDate\":\"2026-06-01\",\"subtotal\":\"900.00\",\"tax\":\"0.00\",\"total\":\"900.00\",\"lineItems\":[{\"position\":1,\"description\":\"Mowing\",\"quantity\":\"1\",\"unitPrice\":\"900.00\",\"amount\":\"900.00\"}]}" | jq -r '.id')
check "an invoice is sent before closing up" "$(status POST "/api/invoices/$INV/mark-sent" '{}')" "200"

# A workspace with no open company breaks the active-company contract, so the
# LAST one can't be closed.
ONLY=$(api GET /api/companies | jq -r '[.companies[] | select(.retiredAt == null)] | length')
echo "      open companies: $ONLY"
check "retiring $CID succeeds" "$(status POST "/api/companies/$CID/retire" '{}')" "200"

# Origination is refused — this is new work.
check "a NEW expense on a closed business is refused" "$(expense 40.00 2026-07-01)" "409"
ERR=$(api POST /api/expenses "{\"companyId\":\"$CID\",\"categoryAccountId\":\"$FUEL\",\"paymentAccountId\":\"$CASH\",\"amount\":\"40.00\",\"expenseDate\":\"2026-07-01\",\"merchant\":\"Fuel\"}" | jq -r '.error')
check "...with the company_retired code" "$ERR" "company_retired"

# Settlement is permitted — the work was already billed, and the money is owed
# to this business. This is the split that made "the old business collects the
# invoices" implementable at all.
check "banking an invoice it already sent is ALLOWED" \
  "$(status POST "/api/invoices/$INV/mark-paid" '{"method":"cash","paidOn":"2026-08-15"}')" "200"

check "reports still work on a closed business" \
  "$(api GET "/api/companies/$CID/balance-sheet?asOf=2026-12-31" | jq -r '.balanced')" "true"

check "reopening works" "$(status POST "/api/companies/$CID/unretire" '{}')" "200"
check "and new work posts again" "$(expense 40.00 2026-07-01)" "201"

section "The last open business can't be closed"
LONE_EMAIL="e2e-lone-$(date +%s)@example.com"
signup "$LONE_EMAIL" || exit 1
LONE=$(api GET /api/companies | jq -r '.companies[0].id')
check "retiring the only business is refused" "$(status POST "/api/companies/$LONE/retire" '{}')" "409"
check "...with the last_active_company code" \
  "$(api POST "/api/companies/$LONE/retire" '{}' | jq -r '.error')" "last_active_company"

summary "02-locks"
