#!/usr/bin/env bash
# TMC-202 — money on an unsent invoice must be reported, not lost.
#
# Walks the exact three states from the ticket and asserts the money is in
# EXACTLY ONE of them at each step. The bug was a hole between two of them, so
# asserting any single number in isolation would have passed throughout: what
# matters is that ready + drafted + billed accounts for the work at every stage.
#
#   bash e2e/probe-draft-gap.sh
source "$(dirname "$0")/lib.sh"

WEB=${TMC_WEB:-http://localhost:5173}
# The RENDERED page, not just the JSON. TMC-201 shipped with a correct API and a
# web layer that dropped the field on the floor — a number the API returns and
# no screen shows is the same bug wearing a different hat.
web() { curl -s -L "$WEB$1" -H "cookie: $COOKIE; active_account_id=$ACCOUNT_ID; active_company_id=$COMPANY_ID"; }

EMAIL="probe-draft-$(date +%s)@example.com"
signup "$EMAIL" || exit 1
api PATCH "/api/companies/$COMPANY_ID" '{"businessType":"sole_prop"}' >/dev/null
api POST /api/legal/accept '{}' >/dev/null

CONTACT=$(api POST /api/contacts "{\"companyId\":\"$COMPANY_ID\",\"name\":\"First Customer\"}" | jq -r '.id')
JOB=$(api POST /api/jobs "{\"companyId\":\"$COMPANY_ID\",\"name\":\"The First New Job\",\"contactId\":\"$CONTACT\"}" | jq -r '.id')

# 2.00 h @ $50.00 = $100.00, matching the reproduction on the ticket.
ENTRY=$(api POST "/api/jobs/$JOB/time" \
  "{\"entryDate\":\"2026-08-08\",\"minutes\":120,\"note\":\"example line item\",\"rate\":\"50.00\"}" | jq -r '.id')

billed()  { api GET "/api/jobs/$JOB" | jq -r '.margin.billed'; }
drafted() { api GET "/api/jobs/$JOB" | jq -r '.margin.drafted'; }
made()    { api GET "/api/jobs/$JOB" | jq -r '.margin.made'; }
ready()   { api GET "/api/jobs?companyId=$COMPANY_ID" | jq -r ".jobs[] | select(.id == \"$JOB\") | .readyToBill"; }
# The whole point: one number, wherever the money currently lives.
accounted() { echo "$(ready)/$(drafted)/$(billed)"; }

section 'hours logged, nothing invoiced'
check 'money is waiting to be billed' "$(accounted)" '100.00/0.00/0.00'

section 'invoice created but NOT sent — the bug'
INV=$(api POST /api/invoices "{\"companyId\":\"$COMPANY_ID\",\"contactId\":\"$CONTACT\",\"jobId\":\"$JOB\",\"number\":\"INV-0001\",\"issueDate\":\"2026-08-08\",\"dueDate\":\"2026-09-07\",\"subtotal\":\"100.00\",\"tax\":\"0.00\",\"total\":\"100.00\",\"lineItems\":[{\"position\":1,\"description\":\"example line item\",\"timeEntryId\":\"$ENTRY\",\"quantity\":\"2.0000\",\"unitPrice\":\"50.00\",\"amount\":\"100.00\",\"unitLabel\":\"hour\",\"type\":\"service\"}]}" | jq -r '.id')
check 'invoice exists and is a draft' "$(api GET "/api/invoices/$INV" | jq -r '.status')" 'draft'
# Was 0.00/—/0.00 before the fix: the $100 was in no bucket at all.
check 'the money moved to drafted, not into thin air' "$(accounted)" '0.00/100.00/0.00'
check 'made stays honest — nobody has been asked to pay yet' "$(made)" '0.00'

section 'invoice sent'
api POST "/api/invoices/$INV/mark-sent" >/dev/null
check 'the money moved on to billed, and drafted emptied' "$(accounted)" '0.00/0.00/100.00'
check 'made now counts it' "$(made)" '100.00'

section 'the jobs-list headline'
SUM=$(api GET "/api/jobs/summary?companyId=$COMPANY_ID")
check 'nothing waiting once sent' "$(jq -r '.readyToBill' <<<"$SUM")" '0.00'
check 'nothing drafted once sent' "$(jq -r '.drafted' <<<"$SUM")" '0.00'

# Draft a second invoice so the summary has something to report, which is the
# state where the headline read "$0.00 nothing waiting" with real money unsent.
api POST "/api/jobs/$JOB/time" \
  '{"entryDate":"2026-08-09","minutes":60,"note":"more","rate":"50.00"}' >/dev/null
ENTRY2=$(api GET "/api/jobs/$JOB/time?unbilled=true" | jq -r '.timeEntries[0].id')
api POST /api/invoices "{\"companyId\":\"$COMPANY_ID\",\"contactId\":\"$CONTACT\",\"jobId\":\"$JOB\",\"number\":\"INV-0002\",\"issueDate\":\"2026-08-09\",\"dueDate\":\"2026-09-08\",\"subtotal\":\"50.00\",\"tax\":\"0.00\",\"total\":\"50.00\",\"lineItems\":[{\"position\":1,\"description\":\"more\",\"timeEntryId\":\"$ENTRY2\",\"quantity\":\"1.0000\",\"unitPrice\":\"50.00\",\"amount\":\"50.00\",\"unitLabel\":\"hour\",\"type\":\"service\"}]}" >/dev/null
SUM=$(api GET "/api/jobs/summary?companyId=$COMPANY_ID")
check 'the headline reports the unsent money' "$(jq -r '.drafted' <<<"$SUM")" '50.00'
check 'and still says nothing is waiting, which is true' "$(jq -r '.readyToBill' <<<"$SUM")" '0.00'

section 'the screens the user actually reads'
JOB_HTML=$(web "/jobs/$JOB")
if contains "$JOB_HTML" '50.00 drafted, not sent'; then
  ok 'the job page says where the unsent money is'
else
  bad 'the job page says where the unsent money is' 'missing: 50.00 drafted, not sent'
fi
LIST_HTML=$(web '/jobs')
if contains "$LIST_HTML" '50.00 drafted, not sent'; then
  ok 'the jobs list headline says it too'
else
  bad 'the jobs list headline says it too' 'missing: 50.00 drafted, not sent'
fi
# The bare lie this whole ticket is about: "nothing waiting" while money is
# unsent. Once a draft exists that phrase must not be the only thing on screen.
if contains "$LIST_HTML" 'nothing waiting'; then
  bad 'the list no longer claims nothing is waiting' 'still reads: nothing waiting'
else
  ok 'the list no longer claims nothing is waiting'
fi

summary 'draft-invoice gap probe'
