#!/usr/bin/env bash
# Shared helpers for the end-to-end walkthrough against a live dev API.
# Every call goes through the real HTTP surface — no in-process app, no test
# harness, no BYPASSRLS superuser. That is the point: RLS is actually enforced
# here in a way the integration suite deliberately bypasses.
set -uo pipefail

# Both overridable from the environment so the whole harness can be pointed at a
# throwaway stack (fresh DB on another port) without touching a live dev
# instance. Defaults are the `pnpm dev` layout.
#
#   TMC_API=http://localhost:3001 TMC_PG=tmc-throwaway-pg ./01-foundations.sh
API=${TMC_API:-http://localhost:3000}
PGC=${TMC_PG:-docker-postgres-1}
# Direct SQL, two ways in.
#
# Locally the database lives in a docker container and `docker exec` is the
# convenient handle. CI has no such container — Postgres is a service the runner
# reaches over TCP — so TMC_DATABASE_URL takes precedence when set and the
# harness talks to psql directly. Without this the suites are un-runnable
# anywhere but a developer laptop, which is how they stayed out of CI.
#
# A function, not a string: these scripts must run under bash, and a string
# holding a command only word-splits by accident.
if [ -n "${TMC_DATABASE_URL:-}" ]; then
  psql_q() { psql "$TMC_DATABASE_URL" -tA -c "$1"; }
else
  psql_q() { docker exec "$PGC" psql -U thalermark -d thalermark -tA -c "$1"; }
fi

# Substring match with NO pipeline. `pipefail` is set above, and
# `echo "$hay" | grep -qF needle` is a trap under it: grep exits the moment it
# matches, echo takes SIGPIPE (141), and pipefail promotes that to the
# pipeline's status. An EARLY match then reports as a failure, and — far worse —
# a negated check reports a match as a pass, so "this is gone now" assertions go
# false-green. Bash pattern matching keeps it in-process.
contains() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }

PASS=0
FAIL=0
FAILED_NAMES=()

ok() { PASS=$((PASS + 1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() {
  FAIL=$((FAIL + 1))
  FAILED_NAMES+=("$1")
  printf '  \033[31m✗\033[0m %s\n' "$1"
  [ $# -gt 1 ] && printf '      %s\n' "$2"
}
check() { # check <name> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$3', got '$2'"; fi
}
section() { printf '\n\033[1m── %s\033[0m\n' "$1"; }

summary() {
  printf '\n\033[1m%s\033[0m  \033[32m%d passed\033[0m' "$1" "$PASS"
  [ "$FAIL" -gt 0 ] && printf '  \033[31m%d failed\033[0m' "$FAIL"
  printf '\n'
  for n in ${FAILED_NAMES+"${FAILED_NAMES[@]}"}; do printf '    \033[31mFAILED:\033[0m %s\n' "$n"; done
  [ "$FAIL" -eq 0 ]
}

# --- session ----------------------------------------------------------------
# Sign up, verify, sign in. The dev mailer can't reach an arbitrary test
# address (Resend 422s outside its allowlist), so the verification gate is
# cleared in the database — the documented local path.
signup() { # signup <email> -> sets COOKIE, ACCOUNT_ID, COMPANY_ID
  local email=$1 code attempt=0
  # RATE_LIMIT_ENABLED is on in dev, and a suite that creates a dozen accounts
  # from one IP will trip it. Back off rather than reporting a product failure.
  while [ $attempt -lt 8 ]; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/auth/sign-up/email" \
      -H 'content-type: application/json' \
      -d "{\"email\":\"$email\",\"password\":\"correct horse battery staple\",\"name\":\"$email\"}")
    [ "$code" = "200" ] && break
    attempt=$((attempt + 1))
    printf '      sign-up %s (attempt %d), waiting…\n' "$code" "$attempt" >&2
    sleep 12
  done
  [ "$code" = "200" ] || { echo "SIGNUP FAILED for $email (HTTP $code)" >&2; return 1; }
  psql_q "update auth_user set email_verified = true where email = '$email';" >/dev/null
  COOKIE=$(curl -s -D - -o /dev/null -X POST "$API/api/auth/sign-in/email" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"correct horse battery staple\"}" |
    grep -i '^set-cookie:' | sed 's/^[Ss]et-[Cc]ookie: //' | cut -d';' -f1 | tr -d '\r' | paste -sd'; ' -)
  [ -n "$COOKIE" ] || { echo "SIGNUP FAILED for $email" >&2; return 1; }
  ACCOUNT_ID=$(psql_q "select m.account_id from memberships m join auth_user u on u.id = m.user_id where u.email = '$email' limit 1;")
  COMPANY_ID=$(psql_q "select id from companies where account_id = '$ACCOUNT_ID' order by created_at limit 1;")
}

api() { # api <METHOD> <path> [json]
  local method=$1 path=$2 body=${3:-}
  if [ -n "$body" ]; then
    curl -s -X "$method" "$API$path" -H "cookie: $COOKIE" -H "x-account-id: $ACCOUNT_ID" \
      -H 'content-type: application/json' -d "$body"
  else
    curl -s -X "$method" "$API$path" -H "cookie: $COOKIE" -H "x-account-id: $ACCOUNT_ID"
  fi
}

status() { # status <METHOD> <path> [json]
  local method=$1 path=$2 body=${3:-}
  if [ -n "$body" ]; then
    curl -s -o /dev/null -w '%{http_code}' -X "$method" "$API$path" -H "cookie: $COOKIE" \
      -H "x-account-id: $ACCOUNT_ID" -H 'content-type: application/json' -d "$body"
  else
    curl -s -o /dev/null -w '%{http_code}' -X "$method" "$API$path" -H "cookie: $COOKIE" -H "x-account-id: $ACCOUNT_ID"
  fi
}

coa() { # coa <companyId> <code>
  psql_q "select id from chart_of_accounts where company_id = '$1' and code = '$2' limit 1;"
}

newco() { # newco <name> <businessType> -> prints id
  api POST /api/companies "{\"name\":\"$1\",\"businessType\":\"$2\"}" | jq -r '.id // .company.id'
}
