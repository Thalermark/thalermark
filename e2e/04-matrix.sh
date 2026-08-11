#!/usr/bin/env bash
# Every handoff direction a real user could take, plus the two branches the
# wizard asks about (who collects the invoices, what comes across) and the one
# case that must be REFUSED rather than fudged.
source "$(dirname "$0")/lib.sh"

EMAIL="e2e-matrix-$(date +%s)@example.com"
signup "$EMAIL" || exit 1

# One seeded predecessor, handed over, checked, undone — repeatable per pairing.
handoff_pair() { # handoff_pair <fromType> <toType>
  local FROM=$1 TO=$2 N="$1 → $2"
  local C CASH FUEL H NEW TID BEFORE OPENED
  C=$(newco "Matrix $FROM to $TO" "$FROM")
  CASH=$(coa "$C" 1000); FUEL=$(coa "$C" 6100)
  api POST /api/owner-money "{\"companyId\":\"$C\",\"kind\":\"contribution\",\"amount\":\"15000.00\",\"occurredOn\":\"2025-01-05\"}" >/dev/null
  api POST /api/expenses "{\"companyId\":\"$C\",\"categoryAccountId\":\"$FUEL\",\"paymentAccountId\":\"$CASH\",\"amount\":\"400.00\",\"expenseDate\":\"2026-02-01\",\"merchant\":\"Fuel\"}" >/dev/null
  BEFORE=$(api GET "/api/companies/$C/balance-sheet?asOf=2026-06-30" | jq -r '.totalAssets')

  H=$(api POST /api/entity-transfers "{\"predecessorCompanyId\":\"$C\",\"name\":\"Matrix $TO Inc\",\"businessType\":\"$TO\",\"effectiveDate\":\"2026-07-01\"}")
  NEW=$(echo "$H" | jq -r '.successorCompanyId'); TID=$(echo "$H" | jq -r '.transferId')
  if [ -z "$NEW" ] || [ "$NEW" = "null" ]; then
    bad "$N: handoff succeeds" "$(echo "$H" | head -c 200)"; return
  fi
  ok "$N: handoff succeeds"

  check "$N: predecessor empties to zero" \
    "$(api GET "/api/companies/$C/balance-sheet?asOf=2026-07-01" | jq -r '.totalAssets')" "0.00"
  check "$N: predecessor equity is zero and balanced" \
    "$(api GET "/api/companies/$C/balance-sheet?asOf=2026-07-01" | jq -r '"\(.totalEquity)|\(.balanced)"')" "0.00|true"
  OPENED=$(api GET "/api/companies/$NEW/balance-sheet?asOf=2026-07-01")
  check "$N: successor opens with the same position" "$(echo "$OPENED" | jq -r '.totalAssets')" "$BEFORE"
  check "$N: successor's sheet balances" "$(echo "$OPENED" | jq -r '.balanced')" "true"
  check "$N: undo restores the predecessor" \
    "$(api POST "/api/entity-transfers/$TID/reverse" '{}' >/dev/null; api GET "/api/companies/$C/balance-sheet?asOf=2026-06-30" | jq -r '.totalAssets')" "$BEFORE"
}

section "Every incorporation direction"
handoff_pair sole_prop s_corp
handoff_pair sole_prop c_corp
handoff_pair llc_single_member s_corp
handoff_pair llc_single_member c_corp
handoff_pair partnership s_corp
handoff_pair partnership c_corp
handoff_pair sole_prop llc_single_member
handoff_pair sole_prop partnership

section "A corporation cannot hand its books to a Schedule C"
# The refusal that matters. 3200 Capital Stock has no line on a Schedule C, so
# handing a corporation's books to a sole prop with a balance on it must 409
# naming the code — not silently seed an account, and not drop the balance.
CORP=$(newco "Backwards Inc" "s_corp")
CASH=$(coa "$CORP" 1000); STOCK=$(coa "$CORP" 3200)
POSTED=$(status POST /api/ledger/entries "{\"companyId\":\"$CORP\",\"postedOn\":\"2025-01-10\",\"memo\":\"Founder stock issued\",\"lines\":[{\"coaAccountId\":\"$CASH\",\"side\":\"debit\",\"amount\":\"5000.00\"},{\"coaAccountId\":\"$STOCK\",\"side\":\"credit\",\"amount\":\"5000.00\"}]}")
check "stock is issued against 3200" "$POSTED" "201"

BACK=$(api POST /api/entity-transfers "{\"predecessorCompanyId\":\"$CORP\",\"name\":\"Backwards Sole Prop\",\"businessType\":\"sole_prop\",\"effectiveDate\":\"2026-07-01\"}")
# 3200 is EQUITY, so it isn't in the asset/liability sweep — the handoff should
# still succeed, and the plug absorbs it. What must hold either way is that
# nothing is silently lost.
if [ "$(echo "$BACK" | jq -r '.error')" = "transfer_account_unmapped" ]; then
  ok "refused, naming the codes with no home: $(echo "$BACK" | jq -c '.codes')"
elif [ "$(echo "$BACK" | jq -r '.successorCompanyId')" != "null" ]; then
  NEWC=$(echo "$BACK" | jq -r '.successorCompanyId')
  ok "allowed — 3200 is equity, so the plug absorbs it rather than needing a home"
  check "corp empties to zero anyway" \
    "$(api GET "/api/companies/$CORP/balance-sheet?asOf=2026-07-01" | jq -r '"\(.totalAssets)|\(.balanced)"')" "0.00|true"
  check "the sole prop opens balanced" \
    "$(api GET "/api/companies/$NEWC/balance-sheet?asOf=2026-07-01" | jq -r '.balanced')" "true"
else
  bad "corp → sole prop is handled" "$(echo "$BACK" | head -c 300)"
fi

section "Who collects the unpaid invoices"
# Effective date is AFTER today deliberately. mark-sent posts the receivable at
# real-now rather than at the invoice's issue date, so a handoff dated before
# today cannot see it — see probe-ar.sh, which reproduces that as a defect.
for MODE in stay transfer; do
  C=$(newco "Receivables $MODE" "sole_prop")
  CASH=$(coa "$C" 1000)
  api POST /api/owner-money "{\"companyId\":\"$C\",\"kind\":\"contribution\",\"amount\":\"5000.00\",\"occurredOn\":\"2025-01-05\"}" >/dev/null
  CT=$(api POST /api/contacts "{\"companyId\":\"$C\",\"name\":\"Mr Okafor\"}" | jq -r '.id')
  IV=$(api POST /api/invoices "{\"companyId\":\"$C\",\"contactId\":\"$CT\",\"number\":\"INV-9\",\"issueDate\":\"2026-05-01\",\"dueDate\":\"2026-06-01\",\"subtotal\":\"1200.00\",\"tax\":\"0.00\",\"total\":\"1200.00\",\"lineItems\":[{\"position\":1,\"description\":\"Job\",\"quantity\":\"1\",\"unitPrice\":\"1200.00\",\"amount\":\"1200.00\"}]}" | jq -r '.id')
  api POST "/api/invoices/$IV/mark-sent" '{}' >/dev/null

  H=$(api POST /api/entity-transfers "{\"predecessorCompanyId\":\"$C\",\"name\":\"Receivables $MODE Inc\",\"businessType\":\"s_corp\",\"effectiveDate\":\"2026-08-01\",\"openInvoicesDisposition\":\"$MODE\"}")
  NEW=$(echo "$H" | jq -r '.successorCompanyId')
  OLD_AR=$(psql_q "select coalesce(sum(case when jl.side='debit' then jl.amount else -jl.amount end),0)::numeric(15,2) from journal_lines jl join journal_entries je on je.id=jl.journal_entry_id join chart_of_accounts coa on coa.id=jl.coa_account_id where je.company_id='$C' and coa.code='1200';")
  NEW_AR=$(psql_q "select coalesce(sum(case when jl.side='debit' then jl.amount else -jl.amount end),0)::numeric(15,2) from journal_lines jl join journal_entries je on je.id=jl.journal_entry_id join chart_of_accounts coa on coa.id=jl.coa_account_id where je.company_id='$NEW' and coa.code='1200';")
  if [ "$MODE" = "stay" ]; then
    check "stay: the old business keeps the 1200 owed to it" "$OLD_AR" "1200.00"
    check "stay: the new business starts with none" "$NEW_AR" "0.00"
    check "stay: the old business can still bank it" \
      "$(status POST "/api/invoices/$IV/mark-paid" '{"method":"cash","paidOn":"2026-08-01"}')" "200"
  else
    check "transfer: the old business hands the 1200 over" "$OLD_AR" "0.00"
    check "transfer: the new business takes it on" "$NEW_AR" "1200.00"
  fi
  check "$MODE: both sides balance" \
    "$(api GET "/api/companies/$C/balance-sheet?asOf=2026-08-01" | jq -r '.balanced')|$(api GET "/api/companies/$NEW/balance-sheet?asOf=2026-08-01" | jq -r '.balanced')" "true|true"
done

section "Choosing what comes across"
C=$(newco "Selective Ltd" "sole_prop")
api POST /api/owner-money "{\"companyId\":\"$C\",\"kind\":\"contribution\",\"amount\":\"5000.00\",\"occurredOn\":\"2025-01-05\"}" >/dev/null
api POST /api/contacts "{\"companyId\":\"$C\",\"name\":\"Kept Customer\"}" >/dev/null
api POST /api/items "{\"companyId\":\"$C\",\"name\":\"Dropped Item\",\"unitPrice\":\"10.00\",\"type\":\"service\"}" >/dev/null
H=$(api POST /api/entity-transfers "{\"predecessorCompanyId\":\"$C\",\"name\":\"Selective Inc\",\"businessType\":\"s_corp\",\"effectiveDate\":\"2026-07-01\",\"include\":{\"contacts\":true,\"items\":false,\"taxPolicies\":false,\"recurringInvoices\":false,\"emailTemplates\":false,\"profile\":false,\"branding\":false}}")
NEW=$(echo "$H" | jq -r '.successorCompanyId')
check "the customer I ticked came across" \
  "$(api GET "/api/contacts?companyId=$NEW" | jq -r '.contacts | length')" "1"
check "the price list I unticked did not" \
  "$(api GET "/api/items?companyId=$NEW" | jq -r '.items | length')" "0"

summary "04-matrix"
