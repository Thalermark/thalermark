#!/usr/bin/env bash
# Foundations: the chart of accounts for every entity type, and the sign of an
# owner draw. Both were touched by this arc — the entity COA seeds landed in
# TMC-124, and 3100 was silently the wrong sign in main until this series.
source "$(dirname "$0")/lib.sh"

EMAIL="e2e-found-$(date +%s)@example.com"
signup "$EMAIL" || exit 1

section "Chart of accounts — all five entity types"

# Codes the ledger posts against BY LITERAL VALUE. If any entity type is missing
# one, a posting into that company throws at runtime rather than at seed time —
# which is exactly the failure this checks for.
REQUIRED=(1000 1200 1500 1900 2000 2700 3000 3100 3900 4000 4100 6100 6200 7000 7950)

for BT in sole_prop llc_single_member partnership s_corp c_corp; do
  CID=$(newco "Probe $BT" "$BT")
  if [ -z "$CID" ] || [ "$CID" = "null" ]; then bad "$BT: company created"; continue; fi
  ok "$BT: company created"

  MISSING=""
  for CODE in "${REQUIRED[@]}"; do
    [ -z "$(coa "$CID" "$CODE")" ] && MISSING="$MISSING $CODE"
  done
  if [ -n "$MISSING" ]; then bad "$BT: every posting code seeded" "missing:$MISSING"; else
    ok "$BT: every posting code seeded"
  fi

  # The bug this series opened with: 3100 seeded debit-normal made an owner
  # draw INCREASE reported equity. It is a contra-equity account and must be
  # credit, mirroring 1900 contra-asset.
  NB=$(psql_q "select normal_balance from chart_of_accounts where company_id='$CID' and code='3100';")
  check "$BT: 3100 is contra-equity (credit)" "$NB" "credit"

  TYPE_3900=$(psql_q "select account_type from chart_of_accounts where company_id='$CID' and code='3900';")
  check "$BT: 3900 transferred-out is equity" "$TYPE_3900" "equity"

  # Each entity files a different federal return, so the tax mapping must differ
  # even though the codes are identical.
  MAPPED=$(psql_q "select count(*) from chart_of_accounts where company_id='$CID' and tax_mapping is not null;")
  if [ "$MAPPED" -gt 0 ]; then ok "$BT: accounts carry a tax mapping ($MAPPED)"; else
    bad "$BT: accounts carry a tax mapping" "none mapped"
  fi
  eval "CID_$BT=$CID"
done

section "Richer charts are supersets of simpler ones"
# The invariant that actually makes a handoff work, and it is a SUBSET one, not
# an equality one. ledger.ts posts by literal code, so every code a sole prop
# can carry a balance on must exist on the chart it hands over to — otherwise
# resolveLegs 409s on a legitimate incorporation.
#
# The converse is deliberately NOT true: a corporation has 3200 Capital Stock
# and 2300 payroll liabilities, which have no line on a Schedule C. Handing a
# corporation's books back to a sole prop with a balance on one of those is
# exactly the transfer_account_unmapped case, and refusing it is correct — a
# balance on a form that entity never files would be worse than an error.
for BT in llc_single_member partnership s_corp c_corp; do
  eval "OTHER=\$CID_$BT"
  MISSING=$(psql_q "select coalesce(string_agg(code, ',' order by code), '') from chart_of_accounts s
    where s.company_id='$CID_sole_prop'
      and not exists (select 1 from chart_of_accounts o where o.company_id='$OTHER' and o.code = s.code);")
  check "$BT chart covers every sole_prop code" "$MISSING" ""
  EXTRA=$(psql_q "select coalesce(string_agg(code, ',' order by code), '(none)') from chart_of_accounts o
    where o.company_id='$OTHER'
      and not exists (select 1 from chart_of_accounts s where s.company_id='$CID_sole_prop' and s.code = o.code);")
  printf '      %s adds: %s\n' "$BT" "$EXTRA"
done

section "Owner draw moves equity the right way"
# The empirical form of the 3100 fix. A draw takes money OUT, so both cash and
# equity must fall, and the sheet must still balance.
CID=$CID_sole_prop
api POST /api/owner-money "{\"companyId\":\"$CID\",\"kind\":\"contribution\",\"amount\":\"10000.00\",\"occurredOn\":\"2025-01-05\"}" >/dev/null
BEFORE=$(api GET "/api/companies/$CID/balance-sheet?asOf=2025-12-31")
EQ_BEFORE=$(echo "$BEFORE" | jq -r '.totalEquity')
check "balances after a contribution" "$(echo "$BEFORE" | jq -r '.balanced')" "true"
check "equity is the contribution" "$EQ_BEFORE" "10000.00"

api POST /api/owner-money "{\"companyId\":\"$CID\",\"kind\":\"draw\",\"amount\":\"2500.00\",\"occurredOn\":\"2025-06-01\"}" >/dev/null
AFTER=$(api GET "/api/companies/$CID/balance-sheet?asOf=2025-12-31")
check "still balances after a draw" "$(echo "$AFTER" | jq -r '.balanced')" "true"
check "a draw REDUCES equity" "$(echo "$AFTER" | jq -r '.totalEquity')" "7500.00"
check "a draw reduces assets to match" "$(echo "$AFTER" | jq -r '.totalAssets')" "7500.00"

summary "01-foundations"
