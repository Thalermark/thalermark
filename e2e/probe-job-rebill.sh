#!/usr/bin/env bash
# Regression probe for the jobs re-bill: hours billed onto an invoice through
# the WEB FORM stayed unbilled, so the job re-offered them and the next invoice
# charged the customer for the same work again.
#
# The API was never broken and its integration tests were green throughout —
# the field was dropped in the web server action, between the form and the API.
# So this drives the actual SvelteKit form POST and then asks the API what it
# believes, which is the only place the two can be caught disagreeing.
#
#   bash e2e/probe-job-rebill.sh
source "$(dirname "$0")/lib.sh"

WEB=${TMC_WEB:-http://localhost:5173}

# POST a SvelteKit form action as the signed-in user. Prints the path the action
# redirected to, or '' when it didn't. `origin` is required — SvelteKit's CSRF
# check rejects a form POST without it.
#
# The redirect arrives in the BODY, not a Location header: SvelteKit answers a
# cross-origin form POST with the action-result envelope
# ({"type":"redirect","location":…}, HTTP 200) rather than a bare 303. A probe
# that asserts on the status code alone reads a successful create as a failure.
web_post() { # web_post <path> <curl-data-args...>
  local path=$1 body
  shift
  body=$(curl -s -X POST "$WEB$path" \
    -H "cookie: $COOKIE; active_account_id=$ACCOUNT_ID; active_company_id=$COMPANY_ID" \
    -H "origin: $WEB" "$@")
  jq -r 'select(.type == "redirect") | .location' <<<"$body" 2>/dev/null
}

EMAIL="probe-rebill-$(date +%s)@example.com"
signup "$EMAIL" || exit 1

# The three gates that block every (app) page (see e2e/07's note).
api PATCH "/api/companies/$COMPANY_ID" '{"businessType":"sole_prop"}' >/dev/null
api POST /api/legal/accept '{}' >/dev/null

CONTACT=$(api POST /api/contacts "{\"companyId\":\"$COMPANY_ID\",\"name\":\"First Customer\"}" | jq -r '.id')
JOB=$(api POST /api/jobs "{\"companyId\":\"$COMPANY_ID\",\"name\":\"second job\",\"contactId\":\"$CONTACT\"}" | jq -r '.id')

entry() { # entry <date> <minutes> <note> -> prints id
  api POST "/api/jobs/$JOB/time" \
    "{\"jobId\":\"$JOB\",\"entryDate\":\"$1\",\"minutes\":$2,\"note\":\"$3\",\"rate\":\"20.00\"}" | jq -r '.id'
}
unbilled_count() { api GET "/api/jobs/$JOB/time?unbilled=true" | jq '.timeEntries | length'; }
billed_to() { api GET "/api/jobs/$JOB/time" | jq -r ".timeEntries[] | select(.id == \"$1\") | .billedInvoiceId"; }
# What the job screen's "ready to bill" tile shows: unbilled hours × their rate.
ready_to_bill() {
  api GET "/api/jobs/$JOB/time?unbilled=true" |
    jq -r '[.timeEntries[] | (.minutes / 60) * ((.rate // "0") | tonumber)] | add // 0 | . * 100 | round / 100 | tostring'
}

E1=$(entry 2026-08-04 240 test)          # 4.00 h @ 20 = 80.00
E2=$(entry 2026-08-06 300 "second test") # 5.00 h @ 20 = 100.00

section 'setup'
check 'two entries logged, both unbilled' "$(unbilled_count)" 2
check 'job advertises them as ready' "$(ready_to_bill)" '180'

# --- the /invoices/new form --------------------------------------------------
# Exactly what the browser submits: one value per line field per row, zipped by
# index server-side. The hidden li_timeEntryId is the field that went missing.
section '/invoices/new bills the hours it lists'
LOCATION=$(web_post "/invoices/new" \
  --data-urlencode "contactId=$CONTACT" \
  --data-urlencode "contactName=First Customer" \
  --data-urlencode "number=INV-9001" \
  --data-urlencode "issueDate=2026-08-08" \
  --data-urlencode "dueDate=2026-09-07" \
  --data-urlencode "notes=" \
  --data-urlencode "jobId=$JOB" \
  --data-urlencode "li_description=second test" \
  --data-urlencode "li_quantity=5.0000" \
  --data-urlencode "li_unitLabel=hour" \
  --data-urlencode "li_unitPrice=20.00" \
  --data-urlencode "li_sourceItemId=" \
  --data-urlencode "li_type=service" \
  --data-urlencode "li_timeEntryId=$E2" \
  --data-urlencode "li_taxable=0" \
  --data-urlencode "li_taxPolicyId=" \
  --data-urlencode "li_description=test" \
  --data-urlencode "li_quantity=4.0000" \
  --data-urlencode "li_unitLabel=hour" \
  --data-urlencode "li_unitPrice=20.00" \
  --data-urlencode "li_sourceItemId=" \
  --data-urlencode "li_type=service" \
  --data-urlencode "li_timeEntryId=$E1" \
  --data-urlencode "li_taxable=0" \
  --data-urlencode "li_taxPolicyId=")
INV=${LOCATION##*/invoices/}
if [ -n "$INV" ]; then ok 'form redirects to the created invoice'; else bad 'form redirects to the created invoice' "no redirect: $LOCATION"; exit 1; fi

# The assertions that fail on the bug. Every one reads back from the API, which
# never saw the web action — no self-consistent loop.
check 'entry 1 stamped to the invoice' "$(billed_to "$E1")" "$INV"
check 'entry 2 stamped to the invoice' "$(billed_to "$E2")" "$INV"
check 'nothing left waiting to bill' "$(unbilled_count)" 0
check 'job no longer advertises the hours' "$(ready_to_bill)" '0'

# --- the /invoices/[id]/edit form --------------------------------------------
# The draft absorbs hours logged after it was started. The trap: PATCH REPLACES
# the billed set from the submitted lines, so the two rows already on the
# invoice must resubmit their ids or the edit silently releases them.
section '/invoices/[id]/edit absorbs new hours without releasing the old'
E3=$(entry 2026-08-08 120 "after create") # 2.00 h @ 20 = 40.00
check 'the new entry is waiting' "$(unbilled_count)" 1

LOCATION=$(web_post "/invoices/$INV/edit" \
  --data-urlencode "contactId=$CONTACT" \
  --data-urlencode "contactName=First Customer" \
  --data-urlencode "number=INV-9001" \
  --data-urlencode "issueDate=2026-08-08" \
  --data-urlencode "dueDate=2026-09-07" \
  --data-urlencode "notes=" \
  --data-urlencode "li_description=second test" \
  --data-urlencode "li_quantity=5.0000" \
  --data-urlencode "li_unitLabel=hour" \
  --data-urlencode "li_unitPrice=20.00" \
  --data-urlencode "li_sourceItemId=" \
  --data-urlencode "li_type=service" \
  --data-urlencode "li_timeEntryId=$E2" \
  --data-urlencode "li_taxable=0" \
  --data-urlencode "li_taxPolicyId=" \
  --data-urlencode "li_description=test" \
  --data-urlencode "li_quantity=4.0000" \
  --data-urlencode "li_unitLabel=hour" \
  --data-urlencode "li_unitPrice=20.00" \
  --data-urlencode "li_sourceItemId=" \
  --data-urlencode "li_type=service" \
  --data-urlencode "li_timeEntryId=$E1" \
  --data-urlencode "li_taxable=0" \
  --data-urlencode "li_taxPolicyId=" \
  --data-urlencode "li_description=after create" \
  --data-urlencode "li_quantity=2.0000" \
  --data-urlencode "li_unitLabel=hour" \
  --data-urlencode "li_unitPrice=20.00" \
  --data-urlencode "li_sourceItemId=" \
  --data-urlencode "li_type=service" \
  --data-urlencode "li_timeEntryId=$E3" \
  --data-urlencode "li_taxable=0" \
  --data-urlencode "li_taxPolicyId=")
check 'edit redirects to the invoice' "$LOCATION" "/invoices/$INV"
check 'the newly-added entry is billed' "$(billed_to "$E3")" "$INV"
check 'the original entries were NOT released' "$(billed_to "$E1")/$(billed_to "$E2")" "$INV/$INV"
check 'nothing waiting after the edit' "$(unbilled_count)" 0

# --- control -----------------------------------------------------------------
# Proves the checks above depend on the field rather than passing for some other
# reason: an hour row submitted WITHOUT its id is exactly the payload the bug
# produced, and it must leave the entry unbilled.
section 'control — a row with no link leaves its entry unbilled'
E4=$(entry 2026-08-09 60 "control")
LOCATION=$(web_post "/invoices/new" \
  --data-urlencode "contactId=$CONTACT" \
  --data-urlencode "contactName=First Customer" \
  --data-urlencode "number=INV-9002" \
  --data-urlencode "issueDate=2026-08-09" \
  --data-urlencode "dueDate=2026-09-08" \
  --data-urlencode "notes=" \
  --data-urlencode "jobId=$JOB" \
  --data-urlencode "li_description=control" \
  --data-urlencode "li_quantity=1.0000" \
  --data-urlencode "li_unitLabel=hour" \
  --data-urlencode "li_unitPrice=20.00" \
  --data-urlencode "li_sourceItemId=" \
  --data-urlencode "li_type=service" \
  --data-urlencode "li_timeEntryId=" \
  --data-urlencode "li_taxable=0" \
  --data-urlencode "li_taxPolicyId=")
if [ -n "$LOCATION" ]; then ok 'control invoice created'; else bad 'control invoice created' "no redirect"; fi
check 'its entry is still unbilled' "$(billed_to "$E4")" 'null'
check 'and the job still offers it' "$(ready_to_bill)" '20'

summary 'job re-bill probe'
