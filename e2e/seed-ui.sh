#!/usr/bin/env bash
# Seed one realistic sole prop for driving the web UI by hand: equipment on
# finance part-way through its life, an unpaid invoice, a customer list, a price
# list and a repeating schedule. Everything the wizard has an opinion about.
source "$(dirname "$0")/lib.sh"

EMAIL=${1:-owner@ridgeline.test}
PASSWORD="correct horse battery staple"

signup "$EMAIL" || exit 1

CID=$COMPANY_ID
# The signup company has no business type yet, which is what parks a new user at
# /welcome. Setting it here skips the wizard so the browser lands in the app.
api PATCH "/api/companies/$CID" '{"businessType":"sole_prop","name":"Ridgeline Lawn Care"}' >/dev/null

CASH=$(coa "$CID" 1000)
FUEL=$(coa "$CID" 6200)

api POST /api/owner-money "{\"companyId\":\"$CID\",\"kind\":\"contribution\",\"amount\":\"20000.00\",\"occurredOn\":\"2024-01-05\"}" >/dev/null
api POST /api/expenses "{\"companyId\":\"$CID\",\"categoryAccountId\":\"$FUEL\",\"paymentAccountId\":\"$CASH\",\"amount\":\"500.00\",\"expenseDate\":\"2026-03-01\",\"merchant\":\"Fuel\"}" >/dev/null
api POST /api/expenses "{\"companyId\":\"$CID\",\"categoryAccountId\":\"$FUEL\",\"paymentAccountId\":\"$CASH\",\"amount\":\"240.00\",\"expenseDate\":\"2025-09-14\",\"merchant\":\"Blades\"}" >/dev/null

PID=$(api POST /api/purchases "{\"companyId\":\"$CID\",\"description\":\"Zero-turn mower\",\"amount\":\"6000.00\",\"purchaseDate\":\"2024-03-01\",\"funding\":\"financed\",\"downPayment\":\"1000.00\",\"taxTreatment\":\"spread\",\"usefulLifeYears\":5}" | jq -r '.id')
api POST /api/purchases "{\"companyId\":\"$CID\",\"description\":\"Trailer\",\"amount\":\"2400.00\",\"purchaseDate\":\"2025-05-01\",\"funding\":\"paid_in_full\",\"taxTreatment\":\"spread\",\"usefulLifeYears\":5}" >/dev/null

api POST /api/tax-policies "{\"companyId\":\"$CID\",\"name\":\"County 7%\",\"rate\":\"7.0000\"}" >/dev/null
api POST /api/items "{\"companyId\":\"$CID\",\"name\":\"Weekly mow\",\"unitPrice\":\"75.00\",\"type\":\"service\"}" >/dev/null
api POST /api/items "{\"companyId\":\"$CID\",\"name\":\"Mulch (per yard)\",\"unitPrice\":\"45.00\",\"type\":\"product\"}" >/dev/null

C1=$(api POST /api/contacts "{\"companyId\":\"$CID\",\"name\":\"Mrs Patel\",\"email\":\"patel@example.com\"}" | jq -r '.id')
api POST /api/contacts "{\"companyId\":\"$CID\",\"name\":\"Okafor Property Group\",\"email\":\"ap@okafor.example.com\"}" >/dev/null

IV=$(api POST /api/invoices "{\"companyId\":\"$CID\",\"contactId\":\"$C1\",\"number\":\"INV-1041\",\"issueDate\":\"2026-06-02\",\"dueDate\":\"2026-07-02\",\"subtotal\":\"900.00\",\"tax\":\"0.00\",\"total\":\"900.00\",\"lineItems\":[{\"position\":1,\"description\":\"Spring cleanup\",\"quantity\":\"1\",\"unitPrice\":\"900.00\",\"amount\":\"900.00\"}]}" | jq -r '.id')
api POST "/api/invoices/$IV/mark-sent" '{}' >/dev/null

# Two years already written down, so the wizard has real carryover to show.
root="$(cd "$(dirname "$0")/../.." && pwd)"
( cd "$root" &&
  DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)" \
  APP_DATABASE_URL="$(grep -m1 '^APP_DATABASE_URL=' .env | cut -d= -f2-)" \
  pnpm --filter @thalermark/api exec tsx "$root/scratch/e2e/sweep.ts" 2026-06-01 >/dev/null 2>&1 )

BS=$(api GET "/api/companies/$CID/balance-sheet?asOf=2026-06-30")
cat <<EOF

  Seeded and ready to drive.

    URL       http://localhost:5173/login
    email     $EMAIL
    password  $PASSWORD

    company   Ridgeline Lawn Care ($CID)
    assets    $(echo "$BS" | jq -r '.totalAssets')   equity $(echo "$BS" | jq -r '.totalEquity')   balanced $(echo "$BS" | jq -r '.balanced')
    mower     still owing $(api GET "/api/purchases/$PID" | jq -r '.owing')
    invoice   INV-1041 sent, unpaid

EOF
