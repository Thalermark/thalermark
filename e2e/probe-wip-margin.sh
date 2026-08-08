#!/usr/bin/env bash
# TMC-203 — a job whose revenue is not recognised yet must not be reported as a
# loss, and its costs must not be charged against the period.
#
# The defect was arithmetic, so the assertions are arithmetic: `billed - costs`
# with nothing billed is the NEGATIVE OF THE COSTS, and printing that told the
# user he had lost the price of his materials on a job he simply had not
# invoiced yet. Those costs are work in progress.
#
#   bash e2e/probe-wip-margin.sh
source "$(dirname "$0")/lib.sh"

WEB=${TMC_WEB:-http://localhost:5173}
web() { curl -s -L "$WEB$1" -H "cookie: $COOKIE; active_account_id=$ACCOUNT_ID; active_company_id=$COMPANY_ID"; }

EMAIL="probe-wip-$(date +%s)@example.com"
signup "$EMAIL" || exit 1
api PATCH "/api/companies/$COMPANY_ID" '{"businessType":"sole_prop"}' >/dev/null
api POST /api/legal/accept '{}' >/dev/null

CONTACT=$(api POST /api/contacts "{\"companyId\":\"$COMPANY_ID\",\"name\":\"Chen\"}" | jq -r '.id')
CASH=$(psql_q "select id from chart_of_accounts where company_id = '$COMPANY_ID' and code = '1000' limit 1;")
SUPPLIES=$(psql_q "select id from chart_of_accounts where company_id = '$COMPANY_ID' and code = '7000' limit 1;")

spend_on_job() { # spend_on_job <jobId> <amount>
  local e
  e=$(api POST /api/expenses "{\"companyId\":\"$COMPANY_ID\",\"categoryAccountId\":\"$SUPPLIES\",\"paymentAccountId\":\"$CASH\",\"amount\":\"$2\",\"expenseDate\":\"2026-06-12\",\"merchant\":\"Nursery\"}" | jq -r '.id')
  api PUT "/api/expenses/$e/allocations" "{\"allocations\":[{\"jobId\":\"$1\",\"share\":\"1\"}]}" >/dev/null
}
invoice() { # invoice <jobId> <number> <amount> <send?>
  local inv
  inv=$(api POST /api/invoices "{\"companyId\":\"$COMPANY_ID\",\"contactId\":\"$CONTACT\",\"jobId\":\"$1\",\"number\":\"$2\",\"issueDate\":\"2026-06-10\",\"dueDate\":\"2026-07-10\",\"subtotal\":\"$3\",\"tax\":\"0.00\",\"total\":\"$3\",\"lineItems\":[{\"position\":1,\"description\":\"Work\",\"quantity\":\"1\",\"unitPrice\":\"$3\",\"amount\":\"$3\",\"type\":\"service\"}]}" | jq -r '.id')
  [ "$4" = "send" ] && api POST "/api/invoices/$inv/mark-sent" >/dev/null
  echo "$inv"
}

# The job in the ticket: $340 of plants, $900 invoice written but not sent.
WIP=$(api POST /api/jobs "{\"companyId\":\"$COMPANY_ID\",\"name\":\"Chen\",\"contactId\":\"$CONTACT\"}" | jq -r '.id')
spend_on_job "$WIP" '340.00'
invoice "$WIP" 'INV-D1' '900.00' draft >/dev/null

section 'the job screen'
M=$(api GET "/api/jobs/$WIP")
check 'costs are real and reported' "$(jq -r '.margin.costs' <<<"$M")" '340.00'
check 'the unsent invoice is reported' "$(jq -r '.margin.drafted' <<<"$M")" '900.00'
# The defect, in one line: this was "-340.00".
check 'no margin is stated, and no loss invented' "$(jq -r '.margin.made' <<<"$M")" 'null'
check 'per hour was already honest' "$(jq -r '.margin.effectiveHourly' <<<"$M")" 'null'

section 'the job screen once the invoice is sent'
SENT=$(api POST /api/jobs "{\"companyId\":\"$COMPANY_ID\",\"name\":\"Smith\",\"contactId\":\"$CONTACT\"}" | jq -r '.id')
spend_on_job "$SENT" '340.00'
invoice "$SENT" 'INV-S1' '900.00' send >/dev/null
M=$(api GET "/api/jobs/$SENT")
check 'a real margin appears' "$(jq -r '.margin.made' <<<"$M")" '560.00'
check 'and nothing is left drafted' "$(jq -r '.margin.drafted' <<<"$M")" '0.00'

section 'the job-margin report'
R=$(api GET "/api/companies/$COMPANY_ID/job-margin?from=2026-06-01&to=2026-06-30")
# The drafted job used to be absent from this report ENTIRELY, taking its $340
# of costs off the report with it — in no bucket at all.
check 'the in-progress job is on the report' \
  "$(jq -r --arg j "$WIP" '[.jobs[] | select(.jobId == $j)] | length' <<<"$R")" '1'
check 'its margin is not stated' "$(jq -r --arg j "$WIP" '.jobs[] | select(.jobId==$j) | .made' <<<"$R")" 'null'
check 'its costs still show' "$(jq -r --arg j "$WIP" '.jobs[] | select(.jobId==$j) | .costs' <<<"$R")" '340.00'
check 'the finished job states its margin' "$(jq -r --arg j "$SENT" '.jobs[] | select(.jobId==$j) | .made' <<<"$R")" '560.00'

section 'the bottom line'
check 'every cost is still counted in jobCosts' "$(jq -r '.totals.jobCosts' <<<"$R")" '680.00'
check 'the in-progress half is named' "$(jq -r '.totals.workInProgress' <<<"$R")" '340.00'
check 'unsent money is named' "$(jq -r '.totals.drafted' <<<"$R")" '900.00'
# Was 220.00 — the total charged the period for the WIP costs while the row
# above it showed no margin, so the total disagreed with its own rows.
check 'only the finished job reaches the bottom line' "$(jq -r '.totals.made' <<<"$R")" '560.00'
# Formatted to 2dp on both sides — jq prints 560 for one and 560.00 for the
# other, and a string compare on that is a probe bug, not a finding.
money2() { awk -v n="$1" 'BEGIN{printf "%.2f", n}'; }
check 'and the totals reconcile' \
  "$(money2 "$(jq -r '(.totals.billed|tonumber) - ((.totals.jobCosts|tonumber) - (.totals.workInProgress|tonumber))' <<<"$R")")" \
  "$(money2 "$(jq -r '.totals.made' <<<"$R")")"

section 'the rendered report'
HTML=$(web '/reports/job-margin?from=2026-06-01&to=2026-06-30')
if contains "$HTML" 'Work in progress'; then ok 'the page names work in progress'; else bad 'the page names work in progress' 'missing'; fi
if contains "$HTML" 'Drafted'; then ok 'the page has a drafted column'; else bad 'the page has a drafted column' 'missing'; fi
# Asserting on the bottom line rather than on "−$340.00" anywhere: the Costs
# column renders costs with a leading minus by design, so that string is
# legitimately on the page and matching it is a false positive.
#
# $560.00 is the finished job alone. $220.00 is what the total said before —
# 900 − 680, the period charged for work in progress whose row showed no margin.
if contains "$HTML" '$560.00'; then
  ok 'the bottom line counts only the finished job'
else
  bad 'the bottom line counts only the finished job' 'missing: $560.00'
fi
if contains "$HTML" '$220.00'; then
  bad 'the bottom line is not charged for work in progress' 'found the old $220.00'
else
  ok 'the bottom line is not charged for work in progress'
fi

summary 'work-in-progress margin probe'
