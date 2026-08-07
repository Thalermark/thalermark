#!/usr/bin/env bash
# Creates one signed-in-able account on the throwaway stack with a company of
# every business type, each carrying enough revenue and spend that its worksheet
# is worth looking at. Use the company switcher to move between the four forms.
source "$(dirname "$0")/lib.sh"

EMAIL=${1:-demo@thalermark.test}
PASS='correct horse battery staple'
Y=2026

# signup() in lib.sh pins its own password, so this does the dance itself to
# keep the credential visible in one place.
curl -s -o /dev/null -X POST "$API/api/auth/sign-up/email" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\",\"name\":\"Demo\"}"
psql_q "update auth_user set email_verified = true where email = '$EMAIL';" >/dev/null
COOKIE=$(curl -s -D - -o /dev/null -X POST "$API/api/auth/sign-in/email" \
  -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" |
  grep -i '^set-cookie:' | sed 's/^[Ss]et-[Cc]ookie: //' | cut -d';' -f1 | tr -d '\r' | paste -sd'; ' -)
[ -n "$COOKIE" ] || { echo "sign-in failed — does $EMAIL already exist?"; exit 1; }
ACCOUNT_ID=$(psql_q "select m.account_id from memberships m join auth_user u on u.id = m.user_id where u.email = '$EMAIL' limit 1;")
COMPANY_ID=$(psql_q "select id from companies where account_id = '$ACCOUNT_ID' order by created_at limit 1;")

revenue() { local cid=$1 amt=$2 c i
  c=$(api POST /api/contacts "{\"companyId\":\"$cid\",\"name\":\"$4\"}" | jq -r '.id')
  i=$(api POST /api/invoices "{\"companyId\":\"$cid\",\"contactId\":\"$c\",\"number\":\"INV-$RANDOM\",\"issueDate\":\"$Y-03-01\",\"dueDate\":\"$Y-03-01\",\"subtotal\":\"$amt\",\"tax\":\"0.00\",\"total\":\"$amt\",\"lineItems\":[{\"position\":1,\"description\":\"$3\",\"quantity\":\"1\",\"unitPrice\":\"$amt\",\"amount\":\"$amt\"}]}" | jq -r '.id')
  api POST "/api/invoices/$i/mark-sent" >/dev/null
  api POST "/api/invoices/$i/mark-paid" "{\"method\":\"cash\",\"paidOn\":\"$Y-03-05\"}" >/dev/null
}
spend() { local cat pay; cat=$(coa "$1" "$2"); pay=$(coa "$1" "1000")
  api POST /api/expenses "{\"companyId\":\"$1\",\"categoryAccountId\":\"$cat\",\"paymentAccountId\":\"$pay\",\"amount\":\"$3\",\"expenseDate\":\"$Y-$4\",\"merchant\":\"$5\"}" >/dev/null
}

# Clears the /welcome gate (needs a business type) and the legal clickwrap.
api PATCH "/api/companies/$COMPANY_ID" '{"name":"Ray'"'"'s Lawn Care","businessType":"sole_prop"}' >/dev/null
api POST /api/legal/accept '{}' >/dev/null

echo "seeding Schedule C…"
revenue "$COMPANY_ID" "38400.00" "Spring cleanups" "Marina Ostrowski"
spend "$COMPANY_ID" 6000 "500.00"  "04-01" "Local Paper"
spend "$COMPANY_ID" 6100 "1840.55" "04-02" "Shell"
spend "$COMPANY_ID" 7000 "3105.60" "04-03" "Site Supply Co"
spend "$COMPANY_ID" 6400 "1200.00" "04-04" "Statewide Insurance"
spend "$COMPANY_ID" 7900 "40.00"   "04-05" "Misc"
spend "$COMPANY_ID" 7950 "1113.60" "04-06" "Stripe"

echo "seeding Form 1065…"
P=$(newco "Two Guys Landscaping" "partnership")
revenue "$P" "126500.00" "Commercial grounds contract" "Halvorsen Property Group"
spend "$P" 6900 "2175.00"  "05-01" "Mower Repair"
spend "$P" 6350 "4900.00"  "05-02" "Depreciation"
spend "$P" 7550 "48000.00" "05-03" "Partner draw — guaranteed payment"
spend "$P" 6700 "1240.00"  "06-01" "Staples"
spend "$P" 7000 "9105.60"  "06-02" "Site Supply Co"
spend "$P" 7400 "2088.12"  "06-03" "City Utilities"
spend "$P" 7200 "860.40"   "06-04" "Trade show travel"
spend "$P" 6600 "3400.00"  "06-05" "Bregman & Ntsiki LLP"

echo "seeding Form 1120-S…"
S=$(newco "Cascade Grounds Inc" "s_corp")
revenue "$S" "410000.00" "Municipal maintenance" "City of Fernbrook"
spend "$S" 6000 "12500.00" "04-01" "Ad agency"
spend "$S" 6900 "8200.00"  "04-02" "Fleet service"
spend "$S" 6700 "3300.00"  "04-03" "Staples"
spend "$S" 7000 "22400.00" "04-04" "Site Supply Co"
spend "$S" 7100 "9800.00"  "04-05" "State of Oregon"

echo "seeding Form 1120…"
C=$(newco "Thalerworks Holdings" "c_corp")
revenue "$C" "880000.00" "Annual service agreement" "Nakagawa Industrial"
spend "$C" 7000 "41000.00"  "04-01" "Site Supply Co"
spend "$C" 6600 "26500.00"  "04-02" "Bregman & Ntsiki LLP"
spend "$C" 6350 "31000.00"  "04-03" "Depreciation"
spend "$C" 7800 "104300.00" "04-04" "IRS — corporate income tax"

printf '\n\033[1mThrowaway login\033[0m\n'
printf '  web       %s\n' "${TMC_WEB:-http://localhost:5174}"
printf '  email     %s\n' "$EMAIL"
printf '  password  %s\n' "$PASS"
printf '\n  Company switcher (top nav) moves between the four forms:\n'
printf "    Ray's Lawn Care        Schedule C   — mileage flag, 27a itemised\n"
printf '    Two Guys Landscaping   Form 1065    — 16a/16c sub-lines, 6 accounts on L20\n'
printf '    Cascade Grounds Inc    Form 1120-S  — advertising on its own L16, L7 at zero\n'
printf '    Thalerworks Holdings   Form 1120    — L31 tax OUTSIDE total deductions\n'
printf '\n  Reports → the worksheet card is named for whichever form is active.\n'
