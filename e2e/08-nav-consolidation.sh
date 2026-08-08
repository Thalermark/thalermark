#!/usr/bin/env bash
# The nav + settings consolidation, walked in a running app. Every check here is
# a rendering or routing question that lint and svelte-check cannot answer.
#
# Point at a throwaway stack with TMC_API / TMC_PG / TMC_WEB (see lib.sh).
source "$(dirname "$0")/lib.sh"

WEB=${TMC_WEB:-http://localhost:5173}

# GET a page as the signed-in user. Follows redirects.
web() { # web <path>
  curl -s -L "$WEB$1" -H "cookie: $COOKIE; active_account_id=$ACCOUNT_ID; active_company_id=$COMPANY_ID"
}
web_status() { curl -s -o /dev/null -w '%{http_code}' -L "$WEB$1" -H "cookie: $COOKIE; active_account_id=$ACCOUNT_ID; active_company_id=$COMPANY_ID"; }
web_code() { curl -s -o /dev/null -w '%{http_code}' "$WEB$1" -H "cookie: $COOKIE; active_account_id=$ACCOUNT_ID; active_company_id=$COMPANY_ID"; }
web_to() { curl -s -o /dev/null -w '%{redirect_url}' "$WEB$1" -H "cookie: $COOKIE; active_account_id=$ACCOUNT_ID; active_company_id=$COMPANY_ID"; }

has()   { if contains "$2" "$3"; then ok "$1"; else bad "$1" "missing: $3"; fi; }
hasnt() { if contains "$2" "$3"; then bad "$1" "unexpectedly present: $3"; else ok "$1"; fi; }

EMAIL="e2e-nav-$(date +%s)@example.com"
signup "$EMAIL" || exit 1
# Three gates block every (app) page: email verification (signup does it),
# the /welcome wizard (needs a business type), and the legal clickwrap — which
# renders OVER the page rather than redirecting, so skipping it gives a 200 full
# of the wrong HTML.
api PATCH "/api/companies/$COMPANY_ID" '{"businessType":"sole_prop"}' >/dev/null
api POST /api/legal/accept '{}' >/dev/null

# ---------------------------------------------------------------------------
section "Top nav — five items, in usage order"

NAV=$(web /invoices)
check "invoices renders"          "$(web_status /invoices)" "200"
has  "Invoices"                   "$NAV" '>Invoices</a>'
has  "Estimates"                  "$NAV" '>Estimates</a>'
has  "Expenses"                   "$NAV" '>Expenses</a>'
has  "Contacts"                   "$NAV" '>Contacts</a>'
has  "Reports"                    "$NAV" '>Reports</a>'
hasnt "Recurring is gone from nav" "$NAV" '>Recurring</a>'
# Global search (TMC-198) sits beside the nav as a collapsed magnifier, so it
# adds no sixth link — but it must not silently disappear either. It's a
# <button> rather than an <a>, which is also why the five assertions above are
# untouched by it.
has  "search button is rendered"  "$NAV" 'aria-label="Search"'

# ---------------------------------------------------------------------------
section "Repeating invoices are still reachable"

# The menu itself is {#if open} — client-only. What SSR must carry is the caret
# that opens it; without that there is no way in at all.
has  "caret button is rendered"   "$NAV" 'aria-label="Invoice options"'
has  "caret is a menu trigger"    "$NAV" 'aria-haspopup="menu"'
has  "primary action still there" "$NAV" '+ New invoice'
check "the repeating list loads"  "$(web_status /recurring)" "200"
has  "list is titled Repeating"   "$(web /recurring)" "Repeating invoices"
hasnt "no stale 'Recurring' heading" "$(web /recurring)" "Recurring invoices<"

# ---------------------------------------------------------------------------
section "Investments & withdrawals"

OM=$(web /owner-money)
check "page renders"              "$(web_status /owner-money)" "200"
has  "eyebrow is the nav label"   "$OM" "Investments &amp; withdrawals"
has  "h1 is the plain phrase"     "$OM" "You and the business"
hasnt "no 'My Money' anywhere"    "$OM" "My Money"
hasnt "no 'Money in &amp; out' h1" "$OM" "Money in &amp; out<"
has  "filter says Investments"    "$OM" ">Investments</option>"
has  "filter says Withdrawals"    "$OM" ">Withdrawals</option>"
hasnt "starting-balances card gone" "$OM" "Tell us what your business started with"
has  "signpost to Settings stays" "$OM" "Starting balances</a> live in"

# ---------------------------------------------------------------------------
section "Settings — grouped, and Import & export merged"

SET=$(web /settings/import)
check "merged page renders"       "$(web_status /settings/import)" "200"
has  "group: your account"        "$SET" "Your account"
has  "group: your business"       "$SET" "Your business"
has  "group: data"                "$SET" ">Data<"
has  "tab is Import & export"     "$SET" "Import &amp; export</a>"
hasnt "no separate Export tab"    "$SET" ">Export</a>"
has  "h1 is Import & export"      "$SET" "Import &amp; export<span"
has  "the switching pitch"        "$SET" "Coming from other accounting software?"
# Asserted against the RENDERED html, not the source: Svelte collapses the
# newline the .svelte file has between the tag and the text.
has  "…is the prominent heading"  "$SET" '<h2 class="font-serif text-3xl font-light leading-tight text-fg">Coming from other accounting software?'
has  "starting balances beneath"  "$SET" ">Starting balances</h3>"
has  "toggle is plain English"    "$SET" "I have my previous balances"
# The prominent heading now asks the question, so the toggle must NOT ask it
# again — two identical phrases make the toggle look like a no-op.
check "phrase appears exactly once" \
  "$(printf '%s' "$SET" | grep -c 'Coming from other accounting software')" "1"

# Order matters: contacts/items and export are conveniences; the switching pitch
# has a deadline attached, so it sits last and loudest rather than first.
POS_CONTACTS=$(printf '%s' "$SET" | grep -bo 'Contacts &amp; items</h2>' | head -1 | cut -d: -f1)
POS_EXPORT=$(printf '%s' "$SET" | grep -bo 'Take a copy with you</h2>' | head -1 | cut -d: -f1)
POS_SWITCH=$(printf '%s' "$SET" | grep -bo 'Coming from other accounting software?' | head -1 | cut -d: -f1)
if [ "$POS_CONTACTS" -lt "$POS_EXPORT" ] && [ "$POS_EXPORT" -lt "$POS_SWITCH" ]; then
  ok "order: contacts → export → switching"
else
  bad "order: contacts → export → switching" "got $POS_CONTACTS / $POS_EXPORT / $POS_SWITCH"
fi
has  "contacts & items section"   "$SET" "Contacts &amp; items"
has  "export section"             "$SET" "Take a copy with you"
has  "export download link"       "$SET" "/settings/export/download?format="

check "old /settings/export 308s" "$(web_code /settings/export)" "308"
check "…to the merged page"       "$(web_to /settings/export)" "$WEB/settings/import"
has  "following it lands right"   "$(web /settings/export)" "Import &amp; export<span"

# ---------------------------------------------------------------------------
section "The wizard's new last step"

check "the books step renders"    "$(web_status /welcome/books)" "200"
BOOKS=$(web /welcome/books)
has  "step heading"               "$BOOKS" "What you're bringing with you"
has  "same component mounted"     "$BOOKS" "Coming from other accounting software?"
has  "skip reads as skip"         "$BOOKS" "Skip for now"
hasnt "no clear-it affordance"    "$BOOKS" "Clear starting balances"
has  "logo step hands off to it"  "$(web /welcome/brand)" "/welcome/books"

# ---------------------------------------------------------------------------
section "The shared component is genuinely one thing"

# Same markup in all three hosts — if these ever diverge, someone forked it.
OB=$(web /owner-money/opening-balance)
for host in "starting-balances page:$OB" "settings:$SET" "wizard:$BOOKS"; do
  name=${host%%:*}; html=${host#*:}
  has "$name has the balance check" "$html" "Coming from other accounting software?"
done

# ---------------------------------------------------------------------------
section "With a trial balance saved, the advanced view opens everywhere"

# `advanced` defaults to shape === 'full', so this is the only way to see the
# importer server-rendered — and it proves the component behaves the same in all
# three hosts rather than just being imported by them.
CASH=$(coa "$COMPANY_ID" 1000); SUP=$(coa "$COMPANY_ID" 7000); REV=$(coa "$COMPANY_ID" 4000)
curl -s -o /dev/null -X PUT "$API/api/owner-money/opening-balance" \
  -H "cookie: $COOKIE" -H "x-account-id: $ACCOUNT_ID" -H 'content-type: application/json' \
  -d "{\"companyId\":\"$COMPANY_ID\",\"asOfDate\":\"2026-07-28\",\"lines\":[{\"coaAccountId\":\"$CASH\",\"side\":\"debit\",\"amount\":\"5000.00\"},{\"coaAccountId\":\"$SUP\",\"side\":\"debit\",\"amount\":\"3000.00\"},{\"coaAccountId\":\"$REV\",\"side\":\"credit\",\"amount\":\"8000.00\"}]}"

for host in "starting-balances page:/owner-money/opening-balance" "settings:/settings/import" "wizard:/welcome/books"; do
  name=${host%%:*}; path=${host#*:}
  html=$(web "$path")
  has "$name shows the importer"  "$html" "Import them from a file"
  has "$name shows the balance"   "$html" "Balanced"
done

# Clear only renders when there IS something to clear — and never in the wizard,
# where "undo it later" makes no sense mid-setup.
has  "page offers Clear"          "$(web /owner-money/opening-balance)" "Clear starting balances"
hasnt "wizard does not"           "$(web /welcome/books)" "Clear starting balances"

# ---------------------------------------------------------------------------
section "Jargon stays where it's earned"

# "Trial balance" is the accountant's term and the product's premise is that the
# user never has to learn it. It survives in exactly two places, both earned:
# translating itself once, and naming the report they must find in the software
# they're leaving.
OB=$(web /owner-money/opening-balance)
has  "translated once"            "$OB" "will call this a trial balance"
has  "names their old report"     "$OB" 'Export "Trial Balance" as CSV'
hasnt "never leads with it"       "$OB" ">Import a trial balance<"
hasnt "…nor in settings"          "$SET" "Import a trial balance"
hasnt "…nor in the wizard"        "$BOOKS" "trial balance"

summary "nav consolidation"
