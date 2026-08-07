#!/usr/bin/env bash
# §351 carryover basis: a corporation steps into the transferor's shoes. The
# asset keeps its original cost, life and clock — and crucially the successor
# RESUMES the schedule rather than restarting it. Without the carryover columns
# this arc added, a transferred asset would back-post its entire prior
# depreciation history onto the new company's books.
source "$(dirname "$0")/lib.sh"

# Only the two URLs are lifted out of the env file — sourcing the whole thing
# fails on unquoted values like `EMAIL_FROM=Thalermark <hello@…>`, and silently
# at that. TMC_ENV_FILE points this at a throwaway stack's env alongside
# TMC_API/TMC_PG; the quote-stripping handles a file that DID quote its values.
sweep() { # sweep <YYYY-MM-DD>
  local root envfile; root="$(cd "$(dirname "$0")/../.." && pwd)"
  envfile="${TMC_ENV_FILE:-$root/.env}"
  ( cd "$root" &&
    DATABASE_URL="$(grep -m1 '^DATABASE_URL=' "$envfile" | cut -d= -f2- | tr -d "'\"")" \
    APP_DATABASE_URL="$(grep -m1 '^APP_DATABASE_URL=' "$envfile" | cut -d= -f2- | tr -d "'\"")" \
    pnpm --filter @thalermark/api exec tsx "$root/scratch/e2e/sweep.ts" "$1" | tail -1 )
}

depr_total() { # depr_total <companyId>
  psql_q "select coalesce(sum(case when jl.side='debit' then jl.amount else -jl.amount end),0)::numeric(15,2)
          from journal_lines jl
          join journal_entries je on je.id = jl.journal_entry_id
          join chart_of_accounts coa on coa.id = jl.coa_account_id
          where je.company_id = '$1' and coa.code = '6350';"
}
depr_years() { # depr_years <companyId>
  psql_q "select coalesce(string_agg(distinct extract(year from je.posted_at at time zone 'UTC')::text, ',' order by extract(year from je.posted_at at time zone 'UTC')::text), '(none)')
          from journal_lines jl
          join journal_entries je on je.id = jl.journal_entry_id
          join chart_of_accounts coa on coa.id = jl.coa_account_id
          where je.company_id = '$1' and coa.code = '6350';"
}

EMAIL="e2e-depr-$(date +%s)@example.com"
signup "$EMAIL" || exit 1

CID=$(newco "Carryover Landscaping" "sole_prop")
api POST /api/owner-money "{\"companyId\":\"$CID\",\"kind\":\"contribution\",\"amount\":\"20000.00\",\"occurredOn\":\"2024-01-05\"}" >/dev/null
PID=$(api POST /api/purchases "{\"companyId\":\"$CID\",\"description\":\"Mower\",\"amount\":\"6000.00\",\"purchaseDate\":\"2024-03-01\",\"funding\":\"paid_in_full\",\"taxTreatment\":\"spread\",\"usefulLifeYears\":5}" | jq -r '.id')
[ "$PID" != "null" ] && ok "a 2024 mower, written off over 5 years" || { bad "purchase"; exit 1; }

section "The sole prop writes it down for two years"
sweep 2026-06-01 >/dev/null
OLD_TOTAL=$(depr_total "$CID")
check "2024 and 2025 have posted" "$(depr_years "$CID")" "2024,2025"
printf '      written off so far: %s\n' "$OLD_TOTAL"
if [ "$(echo "$OLD_TOTAL > 0" | bc)" = "1" ]; then ok "the write-down is non-zero"; else bad "the write-down is non-zero" "$OLD_TOTAL"; fi

section "Incorporate mid-life"
H=$(api POST /api/entity-transfers "{\"predecessorCompanyId\":\"$CID\",\"name\":\"Carryover Inc\",\"businessType\":\"s_corp\",\"effectiveDate\":\"2026-07-01\"}")
NEW=$(echo "$H" | jq -r '.successorCompanyId')
TID=$(echo "$H" | jq -r '.transferId')
[ "$NEW" != "null" ] && ok "handed over" || { bad "handed over" "$(echo "$H" | head -c 200)"; exit 1; }

CARRIED=$(psql_q "select id from capital_purchases where company_id='$NEW' and deleted_at is null limit 1;")
check "cost carries, not book value" \
  "$(psql_q "select amount from capital_purchases where id='$CARRIED';")" "6000.00"
check "what was already written off carries as prior accumulated" \
  "$(psql_q "select prior_accumulated_depreciation from capital_purchases where id='$CARRIED';")" "$OLD_TOTAL"
check "the clock does not restart — first year is the takeover year" \
  "$(psql_q "select depreciation_start_year from capital_purchases where id='$CARRIED';")" "2026"

section "The successor resumes rather than restarts"
sweep 2027-01-02 >/dev/null
check "the corporation posts 2026 only" "$(depr_years "$NEW")" "2026"
NEW_TOTAL=$(depr_total "$NEW")
printf '      corporation wrote off: %s\n' "$NEW_TOTAL"
# The whole point. Back-posting 2024–25 would hand the corporation a deduction
# the sole prop already took, on a return the sole prop already filed.
# Both bounds matter: zero would mean the sweep never ran (a vacuous pass), and
# more than one year's worth would mean it back-posted the sole prop's history.
if [ "$(echo "$NEW_TOTAL > 0 && $NEW_TOTAL <= 1500" | bc)" = "1" ]; then
  ok "it posted exactly its own year, not the sole prop's"
else
  bad "it posted exactly its own year, not the sole prop's" "posted $NEW_TOTAL"
fi
check "the sole prop's own history is untouched" "$(depr_total "$CID")" "$OLD_TOTAL"

section "Run the sweep again — it must be idempotent"
sweep 2027-01-03 >/dev/null
check "no double-posting on the corporation" "$(depr_total "$NEW")" "$NEW_TOTAL"
check "no double-posting on the sole prop" "$(depr_total "$CID")" "$OLD_TOTAL"

section "A closed business is left alone by the sweep"
# The predecessor is retired. The nightly sweep must skip it — otherwise a
# machine posting would breach the very lock that refuses a user's expense.
check "the closed sole prop gained nothing overnight" "$(depr_total "$CID")" "$OLD_TOTAL"

section "Undo returns the asset with its history intact"
api POST "/api/entity-transfers/$TID/reverse" '{}' >/dev/null
check "the corporation's depreciation is undone" "$(depr_total "$NEW")" "0.00"
check "the sole prop keeps every year it filed" "$(depr_total "$CID")" "$OLD_TOTAL"
check "the sole prop's asset is live again" \
  "$(psql_q "select count(*) from capital_purchases where company_id='$CID' and deleted_at is null;")" "1"
check "both sides still balance" \
  "$(api GET "/api/companies/$CID/balance-sheet?asOf=2027-12-31" | jq -r '.balanced')|$(api GET "/api/companies/$NEW/balance-sheet?asOf=2027-12-31" | jq -r '.balanced')" "true|true"

summary "05-depreciation"
