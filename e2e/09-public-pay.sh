#!/usr/bin/env bash
# TMC-209 — the public invoice → pay path, walked as an ANONYMOUS visitor.
#
# Why this file exists. PUBLIC_PREFIXES (apps/web/src/lib/public-routes.ts,
# applied by the guard in hooks.server.ts) is the list of URL prefixes reachable
# without a session. '/pay/' was missing from it, so every customer who clicked
# Pay on a public invoice at /i/<token> was redirected 303 to /sign-in. Online
# card payment was unreachable for every real customer of every business on the
# platform.
#
# The unit test beside that module asserts the list's CONTENTS. This suite
# asserts the CONSEQUENCE, over HTTP, against a running app — so it still bites
# if the guard stops consulting the list, or consults it at the wrong point.
#
# Nothing caught it, and nothing in this harness COULD have: every helper we
# own — lib.sh's `api`/`status`, the `web*` helpers in 07 and 08 — stamps
# $COOKIE on every request, unconditionally. A logged-in developer session
# satisfies the guard, so the page worked in every hand test and in every suite.
# The product had zero unauthenticated requests under test.
#
# The rule this encodes: a page authorized by a URL token must be asserted
# WITHOUT a cookie, or it is not being asserted at all.
#
# It has since caught the same bug a second time. /forgot-password and
# /reset-password were behind the guard too (TMC-239) — password recovery
# unreachable by the only people who need it — so this suite covers every route
# a stranger is supposed to reach, not just the pay path its name describes.
#
# Point at a throwaway stack with TMC_API / TMC_PG / TMC_WEB (see lib.sh). Like
# 07 and 08, this suite drives the SvelteKit app over TMC_WEB and is NOT wired
# into CI — .github/workflows/e2e.yml runs only e2e/0[1-6]-*.sh, because that
# job builds and serves the api but not the web app. Wiring it up means serving
# the web app in that job; until then this is a run-it-yourself suite.
source "$(dirname "$0")/lib.sh"

WEB=${TMC_WEB:-http://localhost:5173}

# --- anonymous helpers -------------------------------------------------------
# The entire point of the suite. There is no `-H "cookie: …"` here — not an
# empty one, none at all — so these requests are indistinguishable from a
# stranger opening the link out of an invoice email. Reaching for `web` from 08
# instead would silently re-authenticate the request and every assertion below
# would go green while proving nothing.
#
# `anon_code` and `anon_to` deliberately omit `-L`, exactly like 08's `web_code`
# / `web_to`: following the redirect is how this bug hid. A 303 to /sign-in
# followed one hop is a 200 with a page full of the wrong HTML.
anon() { curl -s -L "$WEB$1"; }                                # body, redirects followed
anon_code() { curl -s -o /dev/null -w '%{http_code}' "$WEB$1"; }    # raw status, one hop
anon_to() { curl -s -o /dev/null -w '%{redirect_url}' "$WEB$1"; }   # Location, or empty
anon_api_code() { curl -s -o /dev/null -w '%{http_code}' "$API$1"; }

has() { if contains "$2" "$3"; then ok "$1"; else bad "$1" "missing: $3"; fi; }
hasnt() { if contains "$2" "$3"; then bad "$1" "unexpectedly present: $3"; else ok "$1"; fi; }
isnt() { if [ "$2" = "$3" ]; then bad "$1" "got the forbidden value '$3'"; else ok "$1"; fi; }

# --- setup (the only authenticated part) -------------------------------------
# A business has to exist before a stranger can be sent its invoice, and making
# one needs a session. Everything from "drop the session" onward does not.
EMAIL="e2e-pay-$(date +%s)@example.com"
signup "$EMAIL" || exit 1
CO=$(newco "Public Pay E2E" "sole_prop")
CT=$(api POST /api/contacts \
  "{\"companyId\":\"$CO\",\"name\":\"Wanda Stranger\",\"email\":\"stranger@example.com\"}" | jq -r '.id')
NUM="INV-PAY-$(date +%s)"
INV=$(api POST /api/invoices \
  "{\"companyId\":\"$CO\",\"contactId\":\"$CT\",\"number\":\"$NUM\",\"issueDate\":\"2026-06-02\",\"dueDate\":\"2026-07-02\",\"subtotal\":\"500.00\",\"tax\":\"0.00\",\"total\":\"500.00\",\"lineItems\":[{\"position\":1,\"description\":\"Gutter clearing\",\"quantity\":\"1\",\"unitPrice\":\"500.00\",\"amount\":\"500.00\"}]}" |
  jq -r '.id')

# mark-sent, not /send. Both mint the public token through the same transition
# (apps/api/src/routes/invoices.ts — the `key === 'mark-sent'` branch), and both
# flip draft → sent, which is what makes the invoice `payable`. But /send also
# has to hand the mail to a provider, and the dev mailer 502s on any address
# outside its allowlist. Email delivery is not what's under test; the token is.
api POST "/api/invoices/$INV/mark-sent" '{}' >/dev/null
TOKEN=$(psql_q "select public_token from invoices where id = '$INV';")

# A SECOND invoice, part paid — for TMC-210. Deposits are the normal way this
# trade gets paid, and the whole bug was that the public pages ignored them. The
# deposit has to be recorded here, while we still hold a session; everything the
# stranger sees is asserted after the unset below.
NUM2="INV-DEP-$(date +%s)"
INV2=$(api POST /api/invoices \
  "{\"companyId\":\"$CO\",\"contactId\":\"$CT\",\"number\":\"$NUM2\",\"issueDate\":\"2026-06-02\",\"dueDate\":\"2026-07-02\",\"subtotal\":\"500.00\",\"tax\":\"0.00\",\"total\":\"500.00\",\"lineItems\":[{\"position\":1,\"description\":\"Patio rebuild\",\"quantity\":\"1\",\"unitPrice\":\"500.00\",\"amount\":\"500.00\"}]}" |
  jq -r '.id')
api POST "/api/invoices/$INV2/mark-sent" '{}' >/dev/null
api POST "/api/invoices/$INV2/payments" \
  '{"amount":"200.00","receivedOn":"2026-06-03","method":"cash"}' >/dev/null
TOKEN2=$(psql_q "select public_token from invoices where id = '$INV2';")

section "Setup"
if [ -z "$TOKEN" ] || [ -z "$TOKEN2" ]; then
  bad "both invoices minted a public token" "missing public_token — nothing below can run"
  summary "public pay path"
  exit 1
fi
ok "both invoices minted a public token"
check "the deposit left the invoice open" "$(psql_q "select status from invoices where id = '$INV2';")" "sent"

# Drop the session. `unset` rather than COOKIE="" on purpose: lib.sh runs under
# `set -u`, so if anything below reaches for an authenticated helper by accident
# the shell dies on an unbound variable instead of quietly signing the request.
unset COOKIE ACCOUNT_ID COMPANY_ID

# ---------------------------------------------------------------------------
section "Control — the anonymous helper really has no session"

# First, because it validates the instrument. Without this the whole suite could
# pass while quietly sending a cookie, and the /pay/ assertions further down
# would mean nothing. /invoices is a genuinely private page: logged out, the
# guard must bounce it — and this is also the exact shape the TMC-209 bug
# produced, so it doubles as a worked example of the failure the pin below is
# watching for. Verified by hand on a live stack: any token URL whose prefix is
# absent from PUBLIC_PREFIXES answers `303 → $WEB/sign-in`, which is precisely
# the value the pin forbids.
check "/invoices 303s when logged out" "$(anon_code /invoices)" "303"
check "…straight to the sign-in page" "$(anon_to /invoices)" "$WEB/sign-in"

# ---------------------------------------------------------------------------
section "Control — the public invoice view (pre-existing, must already work)"

# /i/ has been in PUBLIC_PREFIXES since it shipped. A failure here is not a
# product bug, it's a broken harness — wrong port, stack down, token not read.
check "the api serves the token anonymously" "$(anon_api_code "/api/public/invoices/$TOKEN")" "200"
check "/i/<token> renders for a stranger" "$(anon_code "/i/$TOKEN")" "200"
IHTML=$(anon "/i/$TOKEN")
has "…showing the invoice number" "$IHTML" "$NUM"
has "…and who it's from" "$IHTML" "Public Pay E2E"
# Matched against the sign-in page's actual <h1>, not against the string
# "/sign-in": a page that never links to sign-in would satisfy the latter
# vacuously, and a vacuous assertion is worse than none.
hasnt "…and it is not the sign-in page" "$IHTML" "Sign in to Thalermark"

# ---------------------------------------------------------------------------
section "TMC-209 — /pay/<token> does not demand a login"

PAY_CODE=$(anon_code "/pay/$TOKEN")
PAY_TO=$(anon_to "/pay/$TOKEN")
printf '  /pay/<token> → HTTP %s%s\n' "$PAY_CODE" "${PAY_TO:+ → $PAY_TO}"

# THE PIN. Two different 303s can come out of this route and only one is a bug:
#
#   303 → /sign-in     the guard rejected an anonymous visitor. TMC-209. The
#                      customer is asked to create an account to pay a bill.
#   303 → /i/<token>   the loader RAN, found the invoice isn't payable (Stripe
#                      unconfigured, Connect not onboarded, already paid) and
#                      sent the visitor back to the invoice view, which renders
#                      the right state. See the `!invoice.payable` and
#                      `!piRes.ok` branches in
#                      apps/web/src/routes/pay/[token]/+page.server.ts.
#
# So asserting a flat 200 would be wrong. Most stacks — dev laptops, CI, any
# self-host without keys — have no Stripe configured, and a suite that goes red
# for the wrong reason gets ignored, which is the same social mechanism that let
# this bug ship. Assert what is true on every stack instead: the stranger was
# not sent to /sign-in.
isnt "an anonymous visitor is NOT sent to /sign-in" "$PAY_TO" "$WEB/sign-in"

if [ "$PAY_CODE" = "200" ]; then
  ok "the pay page rendered (Stripe is configured on this stack)"
elif [ "$PAY_CODE" = "303" ] && [ "$PAY_TO" = "$WEB/i/$TOKEN" ]; then
  ok "the pay page fell back to the invoice view (no Stripe here) — by design, not the bug"
else
  bad "/pay/<token> ends somewhere legitimate" "HTTP $PAY_CODE → ${PAY_TO:-<no redirect>}"
fi

# Belt and braces, and config-independent: both legitimate destinations render
# "Invoice <number>" (pay/[token]/+page.svelte and i/[token]/+page.svelte). The
# sign-in form never could. So following the redirect and finding this invoice
# at the end of it is the single assertion that holds with or without Stripe.
PAY_HTML=$(anon "/pay/$TOKEN")
has "…and whichever page it lands on is about this invoice" "$PAY_HTML" "$NUM"
hasnt "…and it is never the sign-in form" "$PAY_HTML" "Sign in to Thalermark"

# ---------------------------------------------------------------------------
section "An unknown token is a dead end, not a login prompt"

# What the code actually does, not what would be tidy: the api answers 404 for a
# token matching no invoice, and the loader turns that into
# `throw error(404, 'invoice not found')`. It does NOT redirect to /i/ here —
# that bounce is reserved for a real invoice that isn't payable.
BOGUS="tmc209-no-such-token"
check "/pay/<unknown> 404s" "$(anon_code "/pay/$BOGUS")" "404"
isnt "…rather than routing to sign-in" "$(anon_to "/pay/$BOGUS")" "$WEB/sign-in"
check "…and the public view agrees" "$(anon_code "/i/$BOGUS")" "404"

# ---------------------------------------------------------------------------
section "TMC-210 — a customer who paid a deposit is shown the balance, not the total"

# $500 invoice, $200 already received. The intent has charged $300 since
# TMC-187, but both public pages printed $500 — so the customer was shown one
# number and billed another at the moment they handed over card details.
#
# Never assert a bare money string here. SvelteKit inlines the loader's JSON
# into the SSR response for hydration, so "200.00" and "300.00" are both present
# in the bytes whether or not anything renders them — verified by reverting the
# two pages and watching those checks stay green while every other one in this
# section went red. Match rendered text only: a label, or the figure with the
# markup around it.
DEP_HTML=$(anon "/i/$TOKEN2")
has "the invoice view credits the deposit" "$DEP_HTML" "Paid to date"
has "…for the amount actually received" "$DEP_HTML" "−200.00"
has "…and states the balance still due" "$DEP_HTML" "Balance due"

# The Pay button is the specific thing that lied, so it is the thing most worth
# asserting — but it only renders when the invoice is payable, and payable is
# false wherever Stripe is unconfigured, which includes the CI job. Asking the
# API rather than assuming keeps this suite honest on both kinds of stack: it
# runs the check where the button exists and says so where it doesn't, instead
# of going red for a reason that has nothing to do with the bug.
PAYABLE2=$(curl -s "$API/api/public/invoices/$TOKEN2" | jq -r '.payable')
if [ "$PAYABLE2" = "true" ]; then
  has "the Pay button offers the balance" "$DEP_HTML" "Pay 300.00"
  hasnt "…and never the full total" "$DEP_HTML" "Pay 500.00"
else
  printf '  · Pay button skipped: no Stripe on this stack, so the invoice is not payable\n'
fi

# The pay page prints whatever the PaymentIntent was minted for, returned from
# the same call that created it — so heading, button and charge are one number
# by construction. On a stack with no Stripe this page is the /i/ bounce, which
# is asserted above, so the check is conditional rather than silently skipped.
if [ "$(anon_code "/pay/$TOKEN2")" = "200" ]; then
  PAY2_HTML=$(anon "/pay/$TOKEN2")
  has "the pay page charges the balance" "$PAY2_HTML" "Pay 300.00"
  hasnt "…not the invoice total" "$PAY2_HTML" "Pay 500.00"
  has "…and says why the figure differs" "$PAY2_HTML" "already received"
else
  printf '  · pay page skipped: no Stripe on this stack (the /i/ bounce is asserted above)\n'
fi

# ---------------------------------------------------------------------------
section "TMC-211 — the return banner says what Stripe reported, not what we hoped"

# Stripe appends redirect_status to our return_url on the way back from a
# redirect payment method, and it appends it on FAILURE too. The banner used to
# key on ?paid=1 alone, so a customer whose payment was declined was told
# "Payment received" — and the business stopped chasing an invoice nobody paid.
#
# No Stripe needed to prove this: the banner is a pure function of the query
# string, so the failure mode is one curl away. That it was never curled is the
# whole story of this bug.
FAILED_HTML=$(anon "/i/$TOKEN?paid=1&redirect_status=failed")
hasnt "a FAILED payment is never called received" "$FAILED_HTML" "Payment received"
has "…it is called what it is" "$FAILED_HTML" "didn't go through"
# The retry link is offered only where there is something to retry, so like the
# Pay button it needs a payable invoice. Same reason as the TMC-210 gate above:
# on a stack with no Stripe its absence is correct behaviour, not a regression.
if [ "$(curl -s "$API/api/public/invoices/$TOKEN" | jq -r '.payable')" = "true" ]; then
  has "…and offers a way to try again" "$FAILED_HTML" "Try again"
else
  printf '  · retry link skipped: no Stripe on this stack, so there is nothing to retry\n'
fi

has "a SUCCEEDED payment is acknowledged" \
  "$(anon "/i/$TOKEN?paid=1&redirect_status=succeeded")" "Payment received"

PROC_HTML=$(anon "/i/$TOKEN?paid=1&redirect_status=processing")
hasnt "a PROCESSING payment is not yet received" "$PROC_HTML" "Payment received"
has "…it is still clearing" "$PROC_HTML" "still clearing"

# The truncated / hand-edited URL. Stripe always sends redirect_status, so its
# absence means we do not know — and "we don't know" must not render as "paid".
BARE_HTML=$(anon "/i/$TOKEN?paid=1")
hasnt "a bare ?paid=1 claims nothing" "$BARE_HTML" "Payment received"
has "…and says so honestly" "$BARE_HTML" "still confirming"

# ---------------------------------------------------------------------------
section "TMC-239 — password recovery is reachable by people who cannot sign in"

# The same bug as TMC-209, found a second time on different routes, which is why
# it lives in this suite. /forgot-password and /reset-password were both missing
# from PUBLIC_PATHS, so both answered 303 → /sign-in for anyone without a
# session — i.e. for the entire audience for password recovery. The form was
# unreachable AND the link in the reset email bounced, on every install.
#
# Nothing caught it for the same reason nothing caught /pay/: a developer is
# always signed in, and a signed-in visitor sails straight through the guard.
#
# Asserting the RAW status, not the followed one. A 303 to /sign-in followed one
# hop is a 200 full of the wrong page, which is exactly how this hid.
check "/forgot-password renders for a stranger" "$(anon_code /forgot-password)" "200"
isnt "…and is NOT bounced to sign-in" "$(anon_to /forgot-password)" "$WEB/sign-in"

# The destination of the emailed reset link. The token is nonsense on purpose:
# whether it is valid is the page's business, but the page has to be able to
# TELL you it is invalid, and it cannot do that from behind the guard.
check "/reset-password renders for a stranger" "$(anon_code '/reset-password?token=not-a-real-token')" "200"
isnt "…and is NOT bounced to sign-in" "$(anon_to '/reset-password?token=not-a-real-token')" "$WEB/sign-in"

RECOVER=$(anon /forgot-password)
has "…the recovery form is what actually rendered" "$RECOVER" "Reset your password"
hasnt "…not the sign-in form wearing its URL" "$RECOVER" "Sign in to Thalermark"

summary "public pay path"
