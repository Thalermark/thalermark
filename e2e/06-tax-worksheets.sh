#!/usr/bin/env bash
# TMC-162 — the tax worksheet for all four federal returns, walked over the real
# HTTP surface against a throwaway instance (fresh DB, migrations applied at
# boot, RLS actually enforced — the integration suite runs as a BYPASSRLS
# superuser and cannot prove that half).
#
# LINE NUMBERS ARE NOT STABLE. Every assertion here names a line on a real IRS
# form, and TMC-167 proved those move: the §179D deduction (Form 7205) took a
# line on Schedule C, the 1065 and the 1120-S for TY2023 and pushed everything
# below it down one. This suite was written before that and asserted the old
# numbering for two years without anyone noticing, because it lived in
# gitignored scratch/ and never ran (TMC-195).
#
# So when a check here fails, DO NOT reach for the expected value first. Open
# the form. The numbering below was re-verified line by line against the TY2025
# PDFs on irs.gov on 2026-08-07 — f1040sc (rev. 4/3/25), f1065 (rev. 11/25/25),
# f1120s (rev. 4/7/25), f1120 (rev. 9/26/25) — and matches the tables in
# apps/api/src/lib/tax-worksheet.ts, which carry the same standing burden.
source "$(dirname "$0")/lib.sh"


# GET the worksheet for a company. Prints the JSON body.
sheet() { # sheet <companyId> [querystring]
  api GET "/api/companies/$1/tax-worksheet${2:-}"
}

# One line's amount off a worksheet body. `null` for a line nothing can fill.
amt() { # amt <json> <line>
  echo "$1" | jq -r --arg l "$2" '[.income[],.deductions[]] | map(select(.line==$l)) | .[0].amount // "null"'
}
prop() { # prop <json> <line> <field>
  echo "$1" | jq -r --arg l "$2" --arg f "$3" '[.income[],.deductions[]] | map(select(.line==$l)) | .[0][$f] // "null"'
}

# Post a paid invoice so the company has revenue on a cash basis.
revenue() { # revenue <companyId> <amount> <issue> <paid>
  local cid=$1 amount=$2 issue=$3 paid=$4 contact inv
  contact=$(api POST /api/contacts "{\"companyId\":\"$cid\",\"name\":\"Client\"}" | jq -r '.id')
  inv=$(api POST /api/invoices "{\"companyId\":\"$cid\",\"contactId\":\"$contact\",\"number\":\"INV-$RANDOM\",\"issueDate\":\"$issue\",\"dueDate\":\"$issue\",\"subtotal\":\"$amount\",\"tax\":\"0.00\",\"total\":\"$amount\",\"lineItems\":[{\"position\":1,\"description\":\"Work\",\"quantity\":\"1\",\"unitPrice\":\"$amount\",\"amount\":\"$amount\"}]}" | jq -r '.id')
  api POST "/api/invoices/$inv/mark-sent" >/dev/null
  api POST "/api/invoices/$inv/mark-paid" "{\"method\":\"cash\",\"paidOn\":\"$paid\"}" >/dev/null
}

# Post a direct expense against a chart account by code.
spend() { # spend <companyId> <code> <amount> <date>
  local cat pay
  cat=$(coa "$1" "$2")
  pay=$(coa "$1" "1000")
  [ -n "$cat" ] || { bad "no account $2 on company $1"; return 1; }
  api POST /api/expenses "{\"companyId\":\"$1\",\"categoryAccountId\":\"$cat\",\"paymentAccountId\":\"$pay\",\"amount\":\"$3\",\"expenseDate\":\"$4\",\"merchant\":\"Vendor\"}" >/dev/null
}

EMAIL="e2e-tax-$(date +%s)@example.com"
signup "$EMAIL" || exit 1
Y=2026

# ---------------------------------------------------------------------------
section "Sole proprietor — Schedule C (the shape that already shipped)"

SOLE=$COMPANY_ID
revenue "$SOLE" "12000.00" "$Y-03-01" "$Y-03-05"
spend "$SOLE" 6000 "500.00" "$Y-04-01"   # Advertising      → L8
spend "$SOLE" 6100 "412.80" "$Y-04-02"   # Car & truck      → L9  (also user-supplied)
spend "$SOLE" 7000 "1105.60" "$Y-04-03"  # Supplies         → L22
spend "$SOLE" 7900 "40.00" "$Y-04-04"    # Other expenses   → L27b
spend "$SOLE" 7950 "3.44" "$Y-04-05"     # Merchant fees    → L27b

SC=$(sheet "$SOLE" "?year=$Y&basis=cash")
check "form is Schedule C"            "$(echo "$SC" | jq -r .form)" "Schedule C (Form 1040)"
check "L8 advertising"                "$(amt "$SC" 8)" "500.00"
check "L9 car & truck carries the books' half" "$(amt "$SC" 9)" "412.80"
check "L9 still flagged user-supplied" "$(prop "$SC" 9 userSupplied)" "true"
check "L22 supplies"                  "$(amt "$SC" 22)" "1105.60"
check "L27b rolls both accounts"      "$(amt "$SC" 27b)" "43.44"
check "L27b is the itemised line"     "$(prop "$SC" 27b itemized)" "true"
# The line the §179D deduction took for TY2023, pushing other expenses to 27b.
# Asserted empty-but-present on purpose: if a future renumbering moves the
# catch-all again, the two checks above go quiet and only this one is left
# holding the shape.
check "L27a is §179D, rendered empty" "$(amt "$SC" 27a)" "0.00"
check "L28 total expenses"            "$(echo "$SC" | jq -r .totalDeductions)" "2061.84"
check "L30 home office is blank, not zero" "$(amt "$SC" 30)" "null"
check "L31 net profit"                "$(echo "$SC" | jq -r .netIncome)" "9938.16"
check "income section starts at line 1" "$(echo "$SC" | jq -r '.income[0].line')" "1"

# ---------------------------------------------------------------------------
section "Single-member LLC — also Schedule C"

LLC=$(newco "Solo LLC" "llc_single_member")
LS=$(sheet "$LLC" "?year=$Y")
check "LLC files Schedule C too" "$(echo "$LS" | jq -r .formCode)" "schedule_c"

# ---------------------------------------------------------------------------
section "Partnership — Form 1065"

PART=$(newco "Two Guys Landscaping" "partnership")
revenue "$PART" "20000.00" "$Y-03-01" "$Y-03-05"
spend "$PART" 6900 "175.00" "$Y-05-01"   # Repairs          → L11 (own line)
spend "$PART" 6350 "900.00" "$Y-05-02"   # Depreciation     → L16a
spend "$PART" 6700 "240.00" "$Y-06-01"   # Office           → L21 catch-all
spend "$PART" 7000 "1105.60" "$Y-06-02"  # Supplies         → L21
spend "$PART" 7400 "88.12" "$Y-06-03"    # Utilities        → L21

PS=$(sheet "$PART" "?year=$Y&basis=cash")
check "form is 1065"                  "$(echo "$PS" | jq -r .form)" "Form 1065"
check "income starts at 1a not 1"     "$(echo "$PS" | jq -r '.income[0].line')" "1a"
check "L8 total income"               "$(amt "$PS" 8)" "20000.00"
check "L11 repairs has its own line"  "$(amt "$PS" 11)" "175.00"
check "L16a depreciation"             "$(amt "$PS" 16a)" "900.00"
check "L16b is zero"                  "$(amt "$PS" 16b)" "0.00"
check "L16c nets to 16a"              "$(amt "$PS" 16c)" "900.00"
check "L16a marked as a sub-line"     "$(prop "$PS" 16a subLine)" "true"
check "L21 catch-all sums 3 accounts" "$(amt "$PS" 21)" "1433.72"
check "L21 is itemised"               "$(prop "$PS" 21 itemized)" "true"
check "L21 lists its accounts"        "$(echo "$PS" | jq -r '.deductions[]|select(.line=="21")|.accounts|map(.code)|join(",")')" "6700,7000,7400"
check "L20 is §179D, rendered empty"  "$(amt "$PS" 20)" "0.00"
# 175 + 900 + 1433.72 — depreciation counted ONCE despite showing on 16a and 16c.
check "L22 total deductions"          "$(echo "$PS" | jq -r .totalDeductions)" "2508.72"
check "L23 ordinary business income"  "$(amt "$PS" 23)" "17491.28"
check "1065 has no advertising line"  "$(echo "$PS" | jq -r '[.deductions[]|select(.label|test("Advertising"))]|length')" "0"

# ---------------------------------------------------------------------------
section "S corporation — Form 1120-S"

SCORP=$(newco "Scorp Inc" "s_corp")
revenue "$SCORP" "50000.00" "$Y-03-01" "$Y-03-05"
spend "$SCORP" 6000 "500.00" "$Y-04-01"  # Advertising → L16 (own line here!)
spend "$SCORP" 6700 "300.00" "$Y-04-02"  # Office      → L20 catch-all

SS=$(sheet "$SCORP" "?year=$Y&basis=cash")
check "form is 1120-S"                "$(echo "$SS" | jq -r .form)" "Form 1120-S"
check "L6 total income"               "$(amt "$SS" 6)" "50000.00"
check "L7 officer comp renders at 0"  "$(amt "$SS" 7)" "0.00"
check "L16 advertising has own line"  "$(amt "$SS" 16)" "500.00"
check "L20 catch-all"                 "$(amt "$SS" 20)" "300.00"
check "L20 is itemised"               "$(prop "$SS" 20 itemized)" "true"
check "L19 is §179D, rendered empty"  "$(amt "$SS" 19)" "0.00"
check "L21 total deductions"          "$(echo "$SS" | jq -r .totalDeductions)" "800.00"
check "L22 ordinary business income"  "$(amt "$SS" 22)" "49200.00"

# ---------------------------------------------------------------------------
section "C corporation — Form 1120, and the line-31 trap"

CCORP=$(newco "Ccorp Inc" "c_corp")
revenue "$CCORP" "10000.00" "$Y-03-01" "$Y-03-05"
spend "$CCORP" 7000 "1000.00" "$Y-04-01" # Supplies           → L26 catch-all
spend "$CCORP" 7800 "4200.00" "$Y-04-02" # Income tax expense → L31, NOT a deduction

CS=$(sheet "$CCORP" "?year=$Y&basis=cash")
check "form is 1120"                  "$(echo "$CS" | jq -r .form)" "Form 1120"
check "L11 total income"              "$(amt "$CS" 11)" "10000.00"
check "L26 catch-all"                 "$(amt "$CS" 26)" "1000.00"
check "L31 total tax shows"           "$(amt "$CS" 31)" "4200.00"
# The whole point: 1000, not 5200.
check "L27 total deductions EXCLUDES the tax" "$(echo "$CS" | jq -r .totalDeductions)" "1000.00"
check "L28 taxable income is 9000 not 4800"   "$(amt "$CS" 28)" "9000.00"
check "L29c NOL is blank, not a confident 0"  "$(amt "$CS" 29c)" "null"
check "L30 taxable income"            "$(amt "$CS" 30)" "9000.00"
# L25 read "Reserved for future use" from the TCJA until TY2022, when §179D
# claimed the slot. The 1120 was the one form TMC-167 found structurally intact,
# because the new line landed somewhere already blank and nothing shifted below
# it — so this asserts the label, which moved, not the numbering, which didn't.
check "1120 renders §179D at L25"     "$(prop "$CS" 25 label)" "Energy efficient commercial buildings deduction (attach Form 7205)"

# ---------------------------------------------------------------------------
section "A stale mapping must not land on a plausible wrong line"

# Line 7 is gross royalties on the 1120 and officer compensation on the 1120-S.
# A parser matching /1120/ loosely would put $5,000 of wages onto an income line.
psql_q "update chart_of_accounts set tax_mapping = 'Form 1120-S, Line 7' where company_id = '$CCORP' and code = '7450';" >/dev/null
spend "$CCORP" 7450 "5000.00" "$Y-09-01"
ST=$(sheet "$CCORP" "?year=$Y&basis=cash")
check "wrong-form account did NOT land on L12" "$(amt "$ST" 12)" "0.00"
check "it went to review-these instead"        "$(echo "$ST" | jq -r '.unmappedExpenses|map(.code)|join(",")')" "7450"
check "still counted, so the total ties out"   "$(echo "$ST" | jq -r .totalDeductions)" "6000.00"

# ---------------------------------------------------------------------------
section "Cash vs accrual is still a read-time lens"

LENS=$(newco "Lens Co" "partnership")
revenue "$LENS" "3000.00" "$Y-12-20" "$((Y + 1))-01-05"  # issued in Y, paid in Y+1
CASHY=$(sheet "$LENS" "?year=$Y&basis=cash")
ACCRY=$(sheet "$LENS" "?year=$Y&basis=accrual")
check "cash basis defers to the year paid"  "$(amt "$CASHY" 1a)" "0.00"
check "accrual counts it in the year issued" "$(amt "$ACCRY" 1a)" "3000.00"

# ---------------------------------------------------------------------------
section "Legacy /schedule-c alias — shipped mobile builds depend on it"

LEG=$(api GET "/api/companies/$SOLE/schedule-c?year=$Y&basis=cash")
check "alias still returns the OLD shape"   "$(echo "$LEG" | jq -r '.partI.grossReceipts')" "12000.00"
# The alias promises the old response SHAPE, not the old tax law: partII is
# still every 'mapped' Part II line with 28-31 filtered back out to top-level
# fields, and that range now ends at 27b because the form gained a line.
check "old partII spans 8..27b"             "$(echo "$LEG" | jq -r '"\(.partII[0].line)..\(.partII[-1].line)"')" "8..27b"
check "old totalExpenses field"             "$(echo "$LEG" | jq -r .totalExpenses)" "2061.84"
check "old homeOffice null field"           "$(echo "$LEG" | jq -r '.homeOffice // "null"')" "null"
check "old netProfit field"                 "$(echo "$LEG" | jq -r .netProfit)" "9938.16"
check "alias 409s a partnership"            "$(status GET "/api/companies/$PART/schedule-c?year=$Y")" "409"
check "409 names the form they do file"     "$(api GET "/api/companies/$PART/schedule-c?year=$Y" | jq -r .taxForm)" "Form 1065"

# ---------------------------------------------------------------------------
section "RLS — a worksheet must not leak across accounts"

OTHER_COMPANY=$PART
OLD_COOKIE=$COOKIE OLD_ACCOUNT=$ACCOUNT_ID
signup "e2e-tax-intruder-$(date +%s)@example.com" || exit 1
check "another account gets 404, not data" "$(status GET "/api/companies/$OTHER_COMPANY/tax-worksheet?year=$Y")" "404"
COOKIE=$OLD_COOKIE ACCOUNT_ID=$OLD_ACCOUNT

summary "tax worksheets"
