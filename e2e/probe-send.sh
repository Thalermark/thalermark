#!/usr/bin/env bash
# Does emailing an invoice put it on the books, the way clicking "mark sent"
# does? Both flip draft → sent, so both should post Dr A/R / Cr Revenue.
source "$(dirname "$0")/lib.sh"

ar_for() {
  psql_q "select coalesce(sum(case when jl.side='debit' then jl.amount else -jl.amount end),0)::numeric(15,2)
          from journal_lines jl
          join journal_entries je on je.id = jl.journal_entry_id
          join chart_of_accounts coa on coa.id = jl.coa_account_id
          where je.company_id = '$1' and coa.code = '1200';"
}
revenue_for() {
  psql_q "select coalesce(sum(case when jl.side='credit' then jl.amount else -jl.amount end),0)::numeric(15,2)
          from journal_lines jl
          join journal_entries je on je.id = jl.journal_entry_id
          join chart_of_accounts coa on coa.id = jl.coa_account_id
          where je.company_id = '$1' and coa.code in ('4000','4100');"
}

make_invoice() { # make_invoice <companyId> <contactId> <number>
  api POST /api/invoices "{\"companyId\":\"$1\",\"contactId\":\"$2\",\"number\":\"$3\",\"issueDate\":\"2026-06-02\",\"dueDate\":\"2026-07-02\",\"subtotal\":\"500.00\",\"tax\":\"0.00\",\"total\":\"500.00\",\"lineItems\":[{\"position\":1,\"description\":\"Job\",\"quantity\":\"1\",\"unitPrice\":\"500.00\",\"amount\":\"500.00\"}]}" | jq -r '.id'
}

signup "e2e-send-$(date +%s)@example.com" || exit 1
C=$(newco "Send Probe" "sole_prop")
CT=$(api POST /api/contacts "{\"companyId\":\"$C\",\"name\":\"Mrs Patel\",\"email\":\"patel@example.com\"}" | jq -r '.id')

section "Baseline"
printf '  A/R %s · revenue %s\n' "$(ar_for "$C")" "$(revenue_for "$C")"

section "Path 1 — mark-sent (share a link)"
I1=$(make_invoice "$C" "$CT" INV-A)
api POST "/api/invoices/$I1/mark-sent" '{}' >/dev/null
A1=$(ar_for "$C"); R1=$(revenue_for "$C")
printf '  A/R %s · revenue %s\n' "$A1" "$R1"
check "mark-sent puts it on the books" "$A1|$R1" "500.00|500.00"

section "Path 2 — /send (email it)"
I2=$(make_invoice "$C" "$CT" INV-B)
CODE=$(status POST "/api/invoices/$I2/send" '{}')
STATUS=$(api GET "/api/invoices/$I2" | jq -r '.status')
A2=$(ar_for "$C"); R2=$(revenue_for "$C")
printf '  /send returned HTTP %s · invoice status now "%s"\n' "$CODE" "$STATUS"
printf '  A/R %s · revenue %s\n' "$A2" "$R2"

if [ "$STATUS" = "sent" ]; then
  ok "the invoice is marked sent"
  check "...and emailing it ALSO puts it on the books" "$A2|$R2" "1000.00|1000.00"
else
  bad "the invoice is marked sent" "status is '$STATUS' (HTTP $CODE)"
fi

section "What the customer is told they owe"
printf '  dashboard owed-to-you: %s\n' "$(api GET "/api/dashboard/summary?companyId=$C" 2>/dev/null | jq -r '.owed // "n/a"')"
printf '  balance sheet A/R:     %s\n' "$(api GET "/api/companies/$C/balance-sheet?asOf=2026-12-31" | jq -r '[.assets[] | select(.code=="1200") | .amount] | first // "0.00"')"

summary "probe-send"
