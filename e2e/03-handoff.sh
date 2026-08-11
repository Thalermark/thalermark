#!/usr/bin/env bash
# The incorporation handoff, end to end, over the real HTTP surface: a sole prop
# with equipment on finance, an unpaid invoice, a customer list and a repeating
# schedule becomes an S-corp. Then the whole thing is undone.
source "$(dirname "$0")/lib.sh"

EMAIL="e2e-handoff-$(date +%s)@example.com"
signup "$EMAIL" || exit 1

CID=$(newco "Ridgeline Lawn Care" "sole_prop")
CASH=$(coa "$CID" 1000)
FUEL=$(coa "$CID" 6100)
EFFECTIVE=2026-07-01

section "A sole prop with something to hand over"
api POST /api/owner-money "{\"companyId\":\"$CID\",\"kind\":\"contribution\",\"amount\":\"20000.00\",\"occurredOn\":\"2024-01-05\"}" >/dev/null
api POST /api/expenses "{\"companyId\":\"$CID\",\"categoryAccountId\":\"$FUEL\",\"paymentAccountId\":\"$CASH\",\"amount\":\"500.00\",\"expenseDate\":\"2026-03-01\",\"merchant\":\"Fuel\"}" >/dev/null

PURCHASE=$(api POST /api/purchases "{\"companyId\":\"$CID\",\"description\":\"Zero-turn mower\",\"amount\":\"6000.00\",\"purchaseDate\":\"2024-03-01\",\"funding\":\"financed\",\"downPayment\":\"1000.00\",\"taxTreatment\":\"spread\",\"usefulLifeYears\":5}")
PID=$(echo "$PURCHASE" | jq -r '.id')
if [ -n "$PID" ] && [ "$PID" != "null" ]; then ok "financed equipment recorded"; else
  bad "financed equipment recorded" "$(echo "$PURCHASE" | head -c 200)"; exit 1
fi

TAXP=$(api POST /api/tax-policies "{\"companyId\":\"$CID\",\"name\":\"County 7%\",\"rate\":\"7.0000\"}" | jq -r '.id')
ITEM=$(api POST /api/items "{\"companyId\":\"$CID\",\"name\":\"Weekly mow\",\"unitPrice\":\"75.00\",\"type\":\"service\"}" | jq -r '.id')
CONTACT=$(api POST /api/contacts "{\"companyId\":\"$CID\",\"name\":\"Mrs Patel\",\"email\":\"patel@example.com\"}" | jq -r '.id')
[ "$CONTACT" != "null" ] && ok "customer, price list and tax rate set up" || bad "customer set up"

INV=$(api POST /api/invoices "{\"companyId\":\"$CID\",\"contactId\":\"$CONTACT\",\"number\":\"INV-1\",\"issueDate\":\"2026-05-01\",\"dueDate\":\"2026-06-01\",\"subtotal\":\"900.00\",\"tax\":\"0.00\",\"total\":\"900.00\",\"lineItems\":[{\"position\":1,\"description\":\"Spring cleanup\",\"quantity\":\"1\",\"unitPrice\":\"900.00\",\"amount\":\"900.00\"}]}" | jq -r '.id')
api POST "/api/invoices/$INV/mark-sent" '{}' >/dev/null
ok "an invoice is out and unpaid"

BEFORE=$(api GET "/api/companies/$CID/balance-sheet?asOf=2026-06-30")
ASSETS_BEFORE=$(echo "$BEFORE" | jq -r '.totalAssets')
EQUITY_BEFORE=$(echo "$BEFORE" | jq -r '.totalEquity')
OWED_BEFORE=$(api GET "/api/purchases/$PID" | jq -r '.owing')
check "the sole prop's books balance" "$(echo "$BEFORE" | jq -r '.balanced')" "true"
printf '      assets %s · equity %s · still owed on the mower %s\n' "$ASSETS_BEFORE" "$EQUITY_BEFORE" "$OWED_BEFORE"

section "Preview — what would move, before anything is written"
PREVIEW=$(api GET "/api/entity-transfers/preview?companyId=$CID&effectiveDate=$EFFECTIVE")
check "preview names accounts in words, not codes" \
  "$(echo "$PREVIEW" | jq -r '[.balances[].name] | all(. != null and . != "")')" "true"
printf '      moving: %s\n' "$(echo "$PREVIEW" | jq -r '[.balances[] | "\(.name) \(.amount)"] | join(" · ")')"
check "the unpaid invoice is surfaced for a decision" \
  "$(echo "$PREVIEW" | jq -r '.openInvoices | length')" "1"
check "the mower is offered" "$(echo "$PREVIEW" | jq -r '.assets | length')" "1"
check "preview wrote nothing" \
  "$(api GET "/api/companies/$CID/balance-sheet?asOf=2026-06-30" | jq -r '.totalAssets')" "$ASSETS_BEFORE"

section "The handoff"
HANDOFF=$(api POST /api/entity-transfers "{\"predecessorCompanyId\":\"$CID\",\"name\":\"Ridgeline Lawn Care Inc\",\"businessType\":\"s_corp\",\"effectiveDate\":\"$EFFECTIVE\",\"openInvoicesDisposition\":\"stay\",\"transferAssetIds\":[\"$PID\"]}")
TRANSFER_ID=$(echo "$HANDOFF" | jq -r '.transferId')
NEWCO=$(echo "$HANDOFF" | jq -r '.successorCompanyId')
if [ -n "$NEWCO" ] && [ "$NEWCO" != "null" ]; then ok "the corporation is set up"; else
  bad "the corporation is set up" "$(echo "$HANDOFF" | head -c 300)"; exit 1
fi
printf '      net assets handed over: %s\n' "$(echo "$HANDOFF" | jq -r '.netAssets')"

AFTER=$(api GET "/api/companies/$CID/balance-sheet?asOf=$EFFECTIVE")
check "the sole prop still balances" "$(echo "$AFTER" | jq -r '.balanced')" "true"
# It keeps EXACTLY the receivable it chose to keep, and nothing else. Not zero —
# "stay" means the old business is still owed that $900, so it still holds that
# much equity. Asserting zero here only ever passed because the receivable was
# invisible: mark-sent stamped it with the wall clock, which fell after the
# handover date, so no report as of the handover could see it.
check "...and keeps only the invoice it's still collecting" \
  "$(echo "$AFTER" | jq -r '.totalAssets')" "900.00"
check "...with equity matching it" "$(echo "$AFTER" | jq -r '.totalEquity')" "900.00"

# The whole reason no partial-year close was needed: the plug is A − L, and the
# identity says that equals equity + net income, so total equity lands at zero
# WITHOUT the P&L being touched. The final Schedule C is filed from this.
check "the stub-period P&L survives for the final return" \
  "$(api GET "/api/companies/$CID/profit-loss?from=2026-01-01&to=2026-06-30" | jq -r '.totalExpenses')" "500.00"

OPENED=$(api GET "/api/companies/$NEWCO/balance-sheet?asOf=$EFFECTIVE")
check "the corporation's opening sheet balances" "$(echo "$OPENED" | jq -r '.balanced')" "true"
# Everything the sole prop had, less the receivable it kept.
EXPECTED_OPENING=$(echo "$ASSETS_BEFORE - 900" | bc | xargs printf '%.2f')
check "...and opens with everything except that receivable" \
  "$(echo "$OPENED" | jq -r '.totalAssets')" "$EXPECTED_OPENING"

section "What came across"
check "the customer came across" \
  "$(api GET "/api/contacts?companyId=$NEWCO" | jq -r '[.contacts[] | select(.name == "Mrs Patel")] | length')" "1"
check "the price list came across" \
  "$(api GET "/api/items?companyId=$NEWCO" | jq -r '[.items[] | select(.name == "Weekly mow")] | length')" "1"
check "the invoice did NOT — it belongs to the old books" \
  "$(api GET "/api/invoices?companyId=$NEWCO" | jq -r '.invoices | length')" "0"
check "the old business keeps the invoice it sent" \
  "$(api GET "/api/invoices?companyId=$CID" | jq -r '.invoices | length')" "1"

# The subtle one. loanBalance derives what's owed from entries tagged with the
# purchase id, so an aggregate Cr 2700 would have been invisible: the carried
# mower would read as fully paid off.
CARRIED=$(psql_q "select id from capital_purchases where company_id='$NEWCO' and deleted_at is null limit 1;")
check "the mower carried at ORIGINAL cost, not book value" \
  "$(psql_q "select amount from capital_purchases where id='$CARRIED';")" "6000.00"
check "...keeping its original purchase date" \
  "$(psql_q "select purchase_date from capital_purchases where id='$CARRIED';")" "2024-03-01"
check "...and its first depreciable year is the takeover year" \
  "$(psql_q "select depreciation_start_year from capital_purchases where id='$CARRIED';")" "2026"
check "the loan followed the mower" "$(api GET "/api/purchases/$CARRIED" | jq -r '.owing')" "$OWED_BEFORE"
check "...and the sole prop owes nothing on it now" "$(api GET "/api/purchases/$PID" | jq -r '.owing')" "0.00"

check "the sole prop is closed" \
  "$(api GET /api/companies | jq -r "[.companies[] | select(.id == \"$CID\") | .retiredAt] | map(select(. != null)) | length")" "1"
check "it can still bank the invoice it sent" \
  "$(status POST "/api/invoices/$INV/mark-paid" '{"method":"cash","paidOn":"2026-08-15"}')" "200"

section "Undo"
CURRENT=$(api GET "/api/entity-transfers/current?companyId=$NEWCO")
check "the new business knows it took over" \
  "$(echo "$CURRENT" | jq -r '.transfer.predecessorCompanyId')" "$CID"
check "...and says so it can still be undone" "$(echo "$CURRENT" | jq -r '.transfer.reversible')" "true"

UNDO=$(api POST "/api/entity-transfers/$TRANSFER_ID/reverse" '{}')
if [ "$(echo "$UNDO" | jq -r '.transferId')" = "$TRANSFER_ID" ]; then ok "the handover is undone"; else
  bad "the handover is undone" "$(echo "$UNDO" | head -c 300)"
fi

RESTORED=$(api GET "/api/companies/$CID/balance-sheet?asOf=2026-06-30")
check "the sole prop balances again" "$(echo "$RESTORED" | jq -r '.balanced')" "true"
check "...with the assets it had" "$(echo "$RESTORED" | jq -r '.totalAssets')" "$ASSETS_BEFORE"
check "...and the equity it had" "$(echo "$RESTORED" | jq -r '.totalEquity')" "$EQUITY_BEFORE"
check "it is trading again" \
  "$(api GET /api/companies | jq -r "[.companies[] | select(.id == \"$CID\")][0].retiredAt")" "null"
check "the mower's loan came back to it" "$(api GET "/api/purchases/$PID" | jq -r '.owing')" "$OWED_BEFORE"

EMPTIED=$(api GET "/api/companies/$NEWCO/balance-sheet?asOf=2026-12-31")
check "the corporation's books net to nothing" "$(echo "$EMPTIED" | jq -r '.totalAssets')" "0.00"
check "...and still balance" "$(echo "$EMPTIED" | jq -r '.balanced')" "true"
check "the corporation is closed, not deleted" \
  "$(api GET /api/companies | jq -r "[.companies[] | select(.id == \"$NEWCO\")] | length")" "1"
# Append-only: the entries are still there, they just cancel.
ENTRIES=$(psql_q "select count(*) from journal_entries where company_id='$NEWCO';")
if [ "$ENTRIES" -gt 0 ]; then ok "the ledger kept its history ($ENTRIES entries)"; else
  bad "the ledger kept its history" "no entries left"
fi
check "the carried mower is off the new books" \
  "$(psql_q "select count(*) from capital_purchases where company_id='$NEWCO' and deleted_at is null;")" "0"

check "undoing twice is refused" \
  "$(api POST "/api/entity-transfers/$TRANSFER_ID/reverse" '{}' | jq -r '.error')" "already_reversed"

summary "03-handoff"
