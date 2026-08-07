#!/usr/bin/env bash
# "Who collects the unpaid invoices" has to mean the same thing when the wizard
# asks it and when the transfer acts on it.
#
# It didn't. The preview listed invoices by status while the transfer moved
# whatever sat in A/R before the effective date — and mark-sent stamped the
# receivable with the wall clock, so anything sent before you got round to
# running the wizard was offered and then silently ignored. Both halves are
# fixed: revenue posts on the invoice's issue date, and the preview is bounded
# by the same date the transfer uses.
source "$(dirname "$0")/lib.sh"

ar_for() {
  psql_q "select coalesce(sum(case when jl.side='debit' then jl.amount else -jl.amount end),0)::numeric(15,2)
          from journal_lines jl
          join journal_entries je on je.id = jl.journal_entry_id
          join chart_of_accounts coa on coa.id = jl.coa_account_id
          where je.company_id = '$1' and coa.code = '1200';"
}

run() { # run <effectiveDate> <issueDate> <label> <expectOffered> <expectOldAr> <expectNewAr>
  local C CT IV H NEW SHOWN
  C=$(newco "AR $3" "sole_prop")
  api POST /api/owner-money "{\"companyId\":\"$C\",\"kind\":\"contribution\",\"amount\":\"5000.00\",\"occurredOn\":\"2025-01-05\"}" >/dev/null
  CT=$(api POST /api/contacts "{\"companyId\":\"$C\",\"name\":\"Mr Okafor\"}" | jq -r '.id')
  IV=$(api POST /api/invoices "{\"companyId\":\"$C\",\"contactId\":\"$CT\",\"number\":\"INV-9\",\"issueDate\":\"$2\",\"dueDate\":\"2026-12-01\",\"subtotal\":\"1200.00\",\"tax\":\"0.00\",\"total\":\"1200.00\",\"lineItems\":[{\"position\":1,\"description\":\"Job\",\"quantity\":\"1\",\"unitPrice\":\"1200.00\",\"amount\":\"1200.00\"}]}" | jq -r '.id')
  api POST "/api/invoices/$IV/mark-sent" '{}' >/dev/null

  SHOWN=$(api GET "/api/entity-transfers/preview?companyId=$C&effectiveDate=$1" | jq -r '.openInvoices | length')
  H=$(api POST /api/entity-transfers "{\"predecessorCompanyId\":\"$C\",\"name\":\"AR $3 Inc\",\"businessType\":\"s_corp\",\"effectiveDate\":\"$1\",\"openInvoicesDisposition\":\"transfer\"}")
  NEW=$(echo "$H" | jq -r '.successorCompanyId')

  check "$3: preview offers $4" "$SHOWN" "$4"
  check "$3: old A/R $5 · new A/R $6" "$(ar_for "$C")|$(ar_for "$NEW")" "$5|$6"
}

signup "e2e-ar-$(date +%s)@example.com" || exit 1
echo "Today is $(date +%F). The receivable posts on the invoice's issue date."

section "Issued before the handover — it moves, whenever the wizard is run"
run 2026-08-01 2026-05-01 "wizard run late" 1 "0.00" "1200.00"
run 2026-07-01 2026-05-01 "wizard run earlier" 1 "0.00" "1200.00"

section "Issued after the handover — not the old business's to hand over"
# Its receivable isn't in the transferring balance either, so offering it would
# be asking a question that can't be honoured. Neither happens now.
run 2026-06-01 2026-06-15 "issued after takeover" 0 "1200.00" "0.00"

summary "probe-ar"
