#!/usr/bin/env bash
# TMC-204 — margin must tell "revenue not yet billed" from "revenue cancelled".
#
# Both states carry billed = 0, which is exactly why a guard reading only that
# number gets one of them wrong. TMC-203 shipped such a guard and suppressed a
# loss that was real; the invoice-detail block had no status test at all and
# reported a profit on cancelled revenue.
#
#   bash e2e/probe-cancelled-vs-pending.sh
source "$(dirname "$0")/lib.sh"

WEB=${TMC_WEB:-http://localhost:5173}
web() { curl -s -L "$WEB$1" -H "cookie: $COOKIE; active_account_id=$ACCOUNT_ID; active_company_id=$COMPANY_ID"; }

EMAIL="probe-cancel-$(date +%s)@example.com"
signup "$EMAIL" || exit 1
api PATCH "/api/companies/$COMPANY_ID" '{"businessType":"sole_prop"}' >/dev/null
api POST /api/legal/accept '{}' >/dev/null

CONTACT=$(api POST /api/contacts "{\"companyId\":\"$COMPANY_ID\",\"name\":\"Chen\"}" | jq -r '.id')
CASH=$(psql_q "select id from chart_of_accounts where company_id = '$COMPANY_ID' and code = '1000' limit 1;")
SUPPLIES=$(psql_q "select id from chart_of_accounts where company_id = '$COMPANY_ID' and code = '7000' limit 1;")

cost_for() { # cost_for <json-allocation>
  local e
  e=$(api POST /api/expenses "{\"companyId\":\"$COMPANY_ID\",\"categoryAccountId\":\"$SUPPLIES\",\"paymentAccountId\":\"$CASH\",\"amount\":\"340.00\",\"expenseDate\":\"2026-06-12\",\"merchant\":\"Nursery\"}" | jq -r '.id')
  api PUT "/api/expenses/$e/allocations" "{\"allocations\":[$1]}" >/dev/null
}
new_invoice() { # new_invoice <number> [jobId]
  local job=''
  [ -n "${2:-}" ] && job="\"jobId\":\"$2\","
  api POST /api/invoices "{\"companyId\":\"$COMPANY_ID\",\"contactId\":\"$CONTACT\",$job\"number\":\"$1\",\"issueDate\":\"2026-06-10\",\"dueDate\":\"2026-07-10\",\"subtotal\":\"900.00\",\"tax\":\"0.00\",\"total\":\"900.00\",\"lineItems\":[{\"position\":1,\"description\":\"Work\",\"quantity\":\"1\",\"unitPrice\":\"900.00\",\"amount\":\"900.00\",\"type\":\"service\"}]}" | jq -r '.id'
}
costing() { api GET "/api/invoices/$1" | jq -r '[.jobCosting.billed, .jobCosting.drafted, (.jobCosting.made // "null")] | join("/")'; }
jobmargin() { api GET "/api/jobs/$1" | jq -r '[.margin.billed, .margin.drafted, (.margin.made // "null")] | join("/")'; }

# --- the invoice block, all three states ------------------------------------
# billed/drafted/made. Every one of these read 900.00/-/560.00 before the fix.
section 'the invoice detail block'

D=$(new_invoice INV-DRAFT); cost_for "{\"invoiceId\":\"$D\",\"share\":\"1\"}"
check 'a draft bills nothing, and states no margin' "$(costing "$D")" '0.00/900.00/null'

S=$(new_invoice INV-SENT); cost_for "{\"invoiceId\":\"$S\",\"share\":\"1\"}"
api POST "/api/invoices/$S/mark-sent" >/dev/null
check 'a sent invoice states its margin' "$(costing "$S")" '900.00/0.00/560.00'

V=$(new_invoice INV-VOID); cost_for "{\"invoiceId\":\"$V\",\"share\":\"1\"}"
api POST "/api/invoices/$V/mark-sent" >/dev/null
api POST "/api/invoices/$V/void" >/dev/null
# The money was spent, the revenue is cancelled. That is a loss, not a profit
# and not a blank.
check 'a voided invoice states the loss' "$(costing "$V")" '0.00/0.00/-340.00'

# --- the job screen, pending vs cancelled ------------------------------------
section 'the job screen'

JP=$(api POST /api/jobs "{\"companyId\":\"$COMPANY_ID\",\"name\":\"Pending\",\"contactId\":\"$CONTACT\"}" | jq -r '.id')
cost_for "{\"jobId\":\"$JP\",\"share\":\"1\"}"
new_invoice INV-JP "$JP" >/dev/null
check 'revenue still coming — no margin stated' "$(jobmargin "$JP")" '0.00/900.00/null'

JC=$(api POST /api/jobs "{\"companyId\":\"$COMPANY_ID\",\"name\":\"Cancelled\",\"contactId\":\"$CONTACT\"}" | jq -r '.id')
cost_for "{\"jobId\":\"$JC\",\"share\":\"1\"}"
JCI=$(new_invoice INV-JC "$JC")
api POST "/api/invoices/$JCI/mark-sent" >/dev/null
check 'while sent, a real margin' "$(jobmargin "$JC")" '900.00/0.00/560.00'
api POST "/api/invoices/$JCI/void" >/dev/null
# TMC-203 returned null here, hiding a loss the user really took.
check 'once voided, the loss is stated' "$(jobmargin "$JC")" '0.00/0.00/-340.00'

JH=$(api POST /api/jobs "{\"companyId\":\"$COMPANY_ID\",\"name\":\"Hours pending\",\"contactId\":\"$CONTACT\"}" | jq -r '.id')
cost_for "{\"jobId\":\"$JH\",\"share\":\"1\"}"
api POST "/api/jobs/$JH/time" '{"entryDate":"2026-06-11","minutes":120,"rate":"50.00"}' >/dev/null
check 'unbilled priced hours also count as revenue coming' "$(jobmargin "$JH")" '0.00/0.00/null'

# --- the rendered pages ------------------------------------------------------
section 'the rendered pages'
HTML=$(web "/invoices/$V")
if contains "$HTML" '-340.00'; then ok 'the voided invoice page shows the loss'; else bad 'the voided invoice page shows the loss' 'missing -340.00'; fi
if contains "$HTML" '560.00'; then bad 'the voided invoice page shows no profit' 'found 560.00'; else ok 'the voided invoice page shows no profit'; fi

HTML=$(web "/jobs/$JC")
if contains "$HTML" '−$340.00' || contains "$HTML" '-$340.00'; then
  ok 'the cancelled job page shows the loss'
else
  bad 'the cancelled job page shows the loss' 'missing the negative margin'
fi

summary 'pending vs cancelled revenue probe'
