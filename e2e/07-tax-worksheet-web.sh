#!/usr/bin/env bash
# TMC-162 — the rendered web page, not just the JSON. svelte-check proves the
# template typechecks; only a real request proves it renders, that the loader
# resolves, and that the copy a user actually reads is right.
#
# Point at a throwaway stack with TMC_API / TMC_PG / TMC_WEB (see lib.sh).
source "$(dirname "$0")/lib.sh"

WEB=${TMC_WEB:-http://localhost:5173}

# GET a web page as the signed-in user, following redirects. Prints the HTML.
web() { # web <path> [companyId]
  local extra=""
  [ -n "${2:-}" ] && extra="; active_company_id=$2"
  curl -s -L "$WEB$1" -H "cookie: $COOKIE; active_account_id=$ACCOUNT_ID$extra"
}
web_status() { # web_status <path> [companyId]
  local extra=""
  [ -n "${2:-}" ] && extra="; active_company_id=$2"
  curl -s -o /dev/null -w '%{http_code}' "$WEB$1" -H "cookie: $COOKIE; active_account_id=$ACCOUNT_ID$extra"
}
# Where a path redirects to, without following it.
web_location() { # web_location <path> [companyId]
  local extra=""
  [ -n "${2:-}" ] && extra="; active_company_id=$2"
  curl -s -o /dev/null -w '%{redirect_url}' "$WEB$1" -H "cookie: $COOKIE; active_account_id=$ACCOUNT_ID$extra"
}
has() { # has <name> <html> <needle>
  if contains "$2" "$3"; then ok "$1"; else bad "$1" "missing: $3"; fi
}
hasnt() { # hasnt <name> <html> <needle>
  if contains "$2" "$3"; then bad "$1" "unexpectedly present: $3"; else ok "$1"; fi
}

EMAIL="e2e-web-$(date +%s)@example.com"
signup "$EMAIL" || exit 1
Y=2026

revenue() { # revenue <companyId> <amount> <issue> <paid>
  local cid=$1 amount=$2 contact inv
  contact=$(api POST /api/contacts "{\"companyId\":\"$cid\",\"name\":\"Client\"}" | jq -r '.id')
  inv=$(api POST /api/invoices "{\"companyId\":\"$cid\",\"contactId\":\"$contact\",\"number\":\"INV-$RANDOM\",\"issueDate\":\"$3\",\"dueDate\":\"$3\",\"subtotal\":\"$amount\",\"tax\":\"0.00\",\"total\":\"$amount\",\"lineItems\":[{\"position\":1,\"description\":\"Work\",\"quantity\":\"1\",\"unitPrice\":\"$amount\",\"amount\":\"$amount\"}]}" | jq -r '.id')
  api POST "/api/invoices/$inv/mark-sent" >/dev/null
  api POST "/api/invoices/$inv/mark-paid" "{\"method\":\"cash\",\"paidOn\":\"$4\"}" >/dev/null
}
spend() { # spend <companyId> <code> <amount> <date>
  local cat pay; cat=$(coa "$1" "$2"); pay=$(coa "$1" "1000")
  api POST /api/expenses "{\"companyId\":\"$1\",\"categoryAccountId\":\"$cat\",\"paymentAccountId\":\"$pay\",\"amount\":\"$3\",\"expenseDate\":\"$4\",\"merchant\":\"Vendor\"}" >/dev/null
}

# Three gates block every (app) page and all three have to be cleared or the
# page under test never renders: email verification (signup() does it in the
# DB), the /welcome wizard (needs a business type on the active company), and
# the legal clickwrap wall, which renders OVER the page rather than redirecting
# — so a naive probe gets a 200 full of the wrong HTML.
api PATCH "/api/companies/$COMPANY_ID" '{"businessType":"sole_prop"}' >/dev/null
api POST /api/legal/accept '{}' >/dev/null
SOLE=$COMPANY_ID
revenue "$SOLE" "12000.00" "$Y-03-01" "$Y-03-05"
spend "$SOLE" 6000 "500.00" "$Y-04-01"
spend "$SOLE" 7900 "40.00" "$Y-04-04"
spend "$SOLE" 7950 "3.44" "$Y-04-05"

PART=$(newco "Two Guys Landscaping" "partnership")
revenue "$PART" "20000.00" "$Y-03-01" "$Y-03-05"
spend "$PART" 6900 "175.00" "$Y-05-01"
spend "$PART" 6700 "240.00" "$Y-06-01"
spend "$PART" 7000 "1105.60" "$Y-06-02"
spend "$PART" 7400 "88.12" "$Y-06-03"

CCORP=$(newco "Ccorp Inc" "c_corp")
revenue "$CCORP" "10000.00" "$Y-03-01" "$Y-03-05"
spend "$CCORP" 7000 "1000.00" "$Y-04-01"
spend "$CCORP" 7800 "4200.00" "$Y-04-02"

# ---------------------------------------------------------------------------
section "Reports hub"

HUB=$(web /reports "$PART")
check "hub renders"                    "$(web_status /reports "$PART")" "200"
has  "card is named for the 1065"      "$HUB" "Form 1065 worksheet"
has  "card links to the new path"      "$HUB" "/reports/tax-worksheet"
hasnt "no 'we haven't built yours' note" "$HUB" "haven't built the tax sheet"
hasnt "no dead link to the old path"   "$HUB" "/reports/schedule-c"

HUB_C=$(web /reports "$CCORP")
has  "C-corp hub card says Form 1120"  "$HUB_C" "Form 1120 worksheet"

# ---------------------------------------------------------------------------
section "Sole proprietor — the page that already shipped"

SC=$(web "/reports/tax-worksheet?year=$Y&basis=cash" "$SOLE")
check "renders"                        "$(web_status "/reports/tax-worksheet?year=$Y" "$SOLE")" "200"
has  "heading names the form"          "$SC" "Schedule C (Form 1040) worksheet"
has  "Part I wording kept"             "$SC" "Part I — Income"
has  "Part II wording kept"            "$SC" "Part II — Expenses"
has  "gross receipts"                  "$SC" "\$12,000.00"
has  "advertising"                     "$SC" "\$500.00"
has  "user-supplied flag"              "$SC" "you must supply this"
has  "27a itemised section header"     "$SC" "Line 27a"
has  "itemised lists an account"       "$SC" "Merchant Processing Fees"
has  "Schedule C footnote"             "$SC" "Schedule C part III is not included"

# ---------------------------------------------------------------------------
section "Partnership — Form 1065"

PS=$(web "/reports/tax-worksheet?year=$Y&basis=cash" "$PART")
check "renders"                        "$(web_status "/reports/tax-worksheet?year=$Y" "$PART")" "200"
has  "heading names the 1065"          "$PS" "Form 1065 worksheet"
has  "generic income heading"          "$PS" ">Income<"
has  "generic deductions heading"      "$PS" ">Deductions<"
hasnt "no Schedule C wording"          "$PS" "Part II — Expenses"
has  "1065 line 1a"                    "$PS" "1a"
has  "repairs on its own line"         "$PS" "\$175.00"
has  "catch-all section header"        "$PS" "Line 20 — Other deductions"
has  "attachment explains itself"      "$PS" "File this breakdown with the return"
has  "attachment lists office"         "$PS" "Office Expense"
has  "attachment lists supplies"       "$PS" "Supplies"
has  "attachment lists utilities"      "$PS" "Utilities"
has  "attachment total"                "$PS" "Total — line 20"
has  "1065 catch-all total"            "$PS" "\$1,433.72"
has  "corp footnote, not Sch C"        "$PS" "Schedules K, K-1, L, M-1 and M-2"

# ---------------------------------------------------------------------------
section "C corporation — the line-31 trap, as rendered"

CS=$(web "/reports/tax-worksheet?year=$Y&basis=cash" "$CCORP")
has  "heading names the 1120"          "$CS" "Form 1120 worksheet"
has  "L31 total tax is shown"          "$CS" "Total tax"
has  "the tax amount renders"          "$CS" "\$4,200.00"
has  "taxable income is 9,000"         "$CS" "\$9,000.00"
hasnt "NOT 4,800 — tax stayed out of deductions" "$CS" "\$4,800.00"
has  "reserved line still numbered"    "$CS" "Reserved for future use"

# ---------------------------------------------------------------------------
section "Old bookmarks still land"

check "/reports/schedule-c 308s"       "$(curl -s -o /dev/null -w '%{http_code}' "$WEB/reports/schedule-c?year=$Y&basis=cash" -H "cookie: $COOKIE; active_account_id=$ACCOUNT_ID; active_company_id=$SOLE")" "308"
check "…to the new path, query intact" "$(web_location "/reports/schedule-c?year=$Y&basis=cash" "$SOLE")" "$WEB/reports/tax-worksheet?year=$Y&basis=cash"
# The redirect has to work for a business that never had a Schedule C too.
FOLLOWED=$(web "/reports/schedule-c?year=$Y&basis=cash" "$PART")
has  "partnership following an old link gets its own form" "$FOLLOWED" "Form 1065 worksheet"

summary "tax worksheet — web"
