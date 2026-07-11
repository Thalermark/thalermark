#!/usr/bin/env bash
#
# Thalermark self-host installer.
#
#   curl -fsSL https://raw.githubusercontent.com/Thalermark/thalermark/main/install.sh | bash
#
# What it does:
#   - checks for Docker + the Compose plugin (instructs, never installs them)
#   - downloads the self-host compose file + Caddyfile (unmodified) into ./thalermark/docker
#   - generates all secrets and walks you through the optional settings (LLM, email, Stripe)
#   - writes ./thalermark/.env, then prints the command to bring the stack up
#
# It does NOT start the stack — review .env first, then run the printed command.
#
# Overridable via env: THALERMARK_REPO (default Thalermark/thalermark),
# THALERMARK_REF (config download ref, default main).
#
# AGPL v3. See https://github.com/Thalermark/thalermark.

set -euo pipefail

# --- this script needs bash (printf -v, read -s) -----------------------------
if [ -z "${BASH_VERSION:-}" ]; then
	echo "This installer needs bash. Run:  curl -fsSL <url> | bash" >&2
	exit 1
fi

REPO="${THALERMARK_REPO:-Thalermark/thalermark}"
# Which ref to fetch config (compose file, Caddyfile, .env.example) from.
# Defaults to main; when the operator pins a real image tag below without
# overriding this, it auto-couples to that tag so a pinned image gets the
# matching config. REF_EXPLICIT records whether the operator set it by hand.
REF_EXPLICIT="${THALERMARK_REF:+1}"
REF="${THALERMARK_REF:-main}"
RAW="https://raw.githubusercontent.com/${REPO}/${REF}"
# Point THALERMARK_SRC at a local repo checkout to copy the compose file,
# Caddyfile, and .env.example from disk instead of downloading them — for local
# testing or offline/air-gapped installs.
SRC="${THALERMARK_SRC:-}"

# --- output helpers (everything informational goes to stderr) ----------------
if [ -t 2 ]; then
	B=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
	RED=$'\033[31m'; BLUE=$'\033[36m'; R=$'\033[0m'
else
	B=""; DIM=""; GREEN=""; YELLOW=""; RED=""; BLUE=""; R=""
fi
say()     { printf '%s\n' "$*" >&2; }
section() { printf '\n%s%s%s\n' "$B$BLUE" "$*" "$R" >&2; }
ok()   { printf '%s✓%s %s\n' "$GREEN" "$R" "$*" >&2; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$R" "$*" >&2; }
die()  { printf '%s✗ %s%s\n' "$RED" "$*" "$R" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# --- prompts read from the controlling terminal, so `curl | bash` still works -
# Probe by actually opening /dev/tty for write: it can exist yet be unusable when
# there's no controlling terminal (e.g. piped with no tty), where reads/writes
# fail with "Device not configured". Empty TTY => fall back to defaults.
if { : >/dev/tty; } 2>/dev/null; then TTY=/dev/tty; else TTY=""; fi

# ask VARNAME "prompt" "default"
ask() {
	local __var="$1" prompt="$2" default="${3:-}" reply
	if [ -n "$TTY" ]; then
		if [ -n "$default" ]; then
			printf '%s %s[%s]%s ' "$prompt" "$DIM" "$default" "$R" >"$TTY"
		else
			printf '%s ' "$prompt" >"$TTY"
		fi
		IFS= read -r reply <"$TTY" || reply=""
	else
		reply=""
		warn "No terminal available — using default for ${__var}."
	fi
	[ -z "$reply" ] && reply="$default"
	printf -v "$__var" '%s' "$reply"
}

# ask_secret VARNAME "prompt"  (input not echoed)
ask_secret() {
	local __var="$1" prompt="$2" reply=""
	if [ -n "$TTY" ]; then
		printf '%s ' "$prompt" >"$TTY"
		IFS= read -rs reply <"$TTY" || reply=""
		printf '\n' >"$TTY"
	fi
	printf -v "$__var" '%s' "$reply"
}

# ask_yn "prompt" "default(y/n)" -> returns 0 for yes
ask_yn() {
	local prompt="$1" default="${2:-n}" reply
	local hint="y/N"; [ "$default" = "y" ] && hint="Y/n"
	if [ -n "$TTY" ]; then
		printf '%s %s[%s]%s ' "$prompt" "$DIM" "$hint" "$R" >"$TTY"
		IFS= read -r reply <"$TTY" || reply=""
	else
		reply=""
	fi
	[ -z "$reply" ] && reply="$default"
	case "$reply" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

# --- secret generation (openssl preferred, /dev/urandom fallback) ------------
# DB passwords land inside postgres:// URLs, so they must be URL-safe -> hex.
rand_hex() {
	if have openssl; then openssl rand -hex "$1"
	else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}
rand_b64() {
	if have openssl; then openssl rand -base64 "$1" | tr -d '\n'
	else head -c "$1" /dev/urandom | base64 | tr -d '\n'; fi
}

# --- downloader --------------------------------------------------------------
dl() { # url dest
	if have curl; then curl -fsSL "$1" -o "$2"
	elif have wget; then wget -qO "$2" "$1"
	else die "Need curl or wget to download files."; fi
}

# fetch RELPATH DEST — copy from THALERMARK_SRC if set, else download from RAW.
fetch() {
	local rel="$1" dest="$2"
	if [ -n "$SRC" ]; then
		[ -f "$SRC/$rel" ] || die "Local source missing: $SRC/$rel"
		cp "$SRC/$rel" "$dest"
	else
		dl "$RAW/$rel" "$dest"
	fi
}

# --- set KEY=VALUE in an env file (replace in place, else append) ------------
# VALUE is passed via the environment so awk does no backslash processing.
kv_set() {
	local file="$1" key="$2" tmp; export KV_VAL="$3"
	tmp="$(mktemp)"
	awk -v k="$key" '
		BEGIN { v = ENVIRON["KV_VAL"]; pre = k "="; n = length(pre); set = 0 }
		substr($0, 1, n) == pre { print pre v; set = 1; next }
		{ print }
		END { if (!set) print pre v }
	' "$file" >"$tmp" && mv "$tmp" "$file"
	unset KV_VAL
}

# insert `email <addr>` into the Caddyfile global options block
caddy_set_email() {
	local file="$1" tmp; export CADDY_EMAIL="$2"
	tmp="$(mktemp)"
	awk '
		BEGIN { done = 0 }
		$1 == "default_sni" && !done { print; print "\temail " ENVIRON["CADDY_EMAIL"]; done = 1; next }
		{ print }
	' "$file" >"$tmp" && mv "$tmp" "$file"
	unset CADDY_EMAIL
}

# =============================================================================
say ""
say "${B}  Thalermark — self-host installer${R}"
say "${DIM}  open source, AI-first accounting${R}"

# --- 1. preflight ------------------------------------------------------------
section "Checking prerequisites"

if ! have docker; then
	say ""
	die "Docker is not installed.
  Install Docker Engine + the Compose plugin, then re-run this script:
    Linux:   https://docs.docker.com/engine/install/
    macOS:   https://docs.docker.com/desktop/install/mac-install/
    Windows: https://docs.docker.com/desktop/install/windows-install/"
fi
ok "docker found ($(docker --version 2>/dev/null | head -n1))"

if docker compose version >/dev/null 2>&1; then
	DC="docker compose"
elif have docker-compose; then
	DC="docker-compose"
else
	die "The Docker Compose plugin is not installed.
  See https://docs.docker.com/compose/install/ then re-run this script."
fi
ok "compose found ($DC)"

if ! docker info >/dev/null 2>&1; then
	warn "The Docker daemon doesn't appear to be running — start it before bringing the stack up."
fi

have openssl && ok "openssl found" || warn "openssl not found — falling back to /dev/urandom for secrets."

# --- 2. install directory ----------------------------------------------------
section "Install location"
ask INSTALL_DIR "Directory to install into?" "$PWD/thalermark"
mkdir -p "$INSTALL_DIR/docker"
INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd)"
ENV_FILE="$INSTALL_DIR/.env"

if [ -f "$ENV_FILE" ]; then
	warn "$ENV_FILE already exists — it holds your existing secrets."
	if ! ask_yn "Overwrite it?" "n"; then
		die "Aborted. Move or remove the existing .env first."
	fi
fi
ok "Installing into $INSTALL_DIR"

# --- 3. image version --------------------------------------------------------
section "Image version"
say "${DIM}The compose file pulls prebuilt images from GHCR. Use a release tag for"
say "reproducible deploys, or 'latest' to track the newest release.${R}"
ask THALERMARK_VERSION "Image tag (THALERMARK_VERSION)?" "latest"

# Couple the config ref to a pinned image (tag or SHA) so it ships with the
# compose file/Caddyfile it was released against. 'latest' keeps the default
# ref; an explicit THALERMARK_REF always wins. No-op in local-source mode.
if [ -z "$REF_EXPLICIT" ] && [ -n "$THALERMARK_VERSION" ] && [ "$THALERMARK_VERSION" != "latest" ]; then
	REF="$THALERMARK_VERSION"
	RAW="https://raw.githubusercontent.com/${REPO}/${REF}"
	[ -z "$SRC" ] && say "${DIM}Config will be fetched from '$REF' to match the pinned image.${R}"
fi

# --- 4. download config files ------------------------------------------------
if [ -n "$SRC" ]; then section "Copying config from $SRC"; else section "Downloading config (ref: $REF)"; fi
fetch "docker/docker-compose.yml" "$INSTALL_DIR/docker/docker-compose.yml"; ok "docker/docker-compose.yml"
fetch "docker/Caddyfile"          "$INSTALL_DIR/docker/Caddyfile";          ok "docker/Caddyfile"
fetch ".env.example"              "$ENV_FILE";                              ok ".env (from .env.example)"

# --- 5. generate secrets -----------------------------------------------------
section "Generating secrets"
kv_set "$ENV_FILE" NODE_ENV                 "production"
kv_set "$ENV_FILE" THALERMARK_VERSION       "$THALERMARK_VERSION"
kv_set "$ENV_FILE" BETTER_AUTH_SECRET       "$(rand_b64 32)"
kv_set "$ENV_FILE" STORAGE_URL_SECRET       "$(rand_hex 32)"
# Self-host serves receipts from the local-FS driver + a persistent volume (the
# compose api service hardcodes this). Set it here too so the generated .env is
# honest — .env.example ships the dev MinIO (s3) config, which would otherwise
# look active even though nothing reads it.
kv_set "$ENV_FILE" STORAGE_DRIVER           "local"
kv_set "$ENV_FILE" POSTGRES_PASSWORD        "$(rand_hex 24)"
kv_set "$ENV_FILE" THALERMARK_APP_PASSWORD  "$(rand_hex 24)"
kv_set "$ENV_FILE" THALERMARK_PGBOSS_PASSWORD "$(rand_hex 24)"
ok "auth secret, storage secret, and all Postgres role passwords generated"

# --- 6. domain + TLS ---------------------------------------------------------
section "Domain & TLS"
say "${DIM}Leave as 'localhost' to try it locally (Caddy serves a self-signed cert)."
say "For a public install, enter your domain — Caddy auto-issues a Let's Encrypt"
say "cert, which needs DNS pointed here and ports 80+443 reachable.${R}"
ask THALERMARK_DOMAIN "Domain?" "localhost"
kv_set "$ENV_FILE" THALERMARK_DOMAIN "$THALERMARK_DOMAIN"

# A real hostname (vs localhost or a bare IP) = not localhost and has a letter.
# Only then is an ACME email meaningful — localhost/IP use Caddy's internal CA.
if [ "$THALERMARK_DOMAIN" != "localhost" ] && printf '%s' "$THALERMARK_DOMAIN" | grep -q '[a-zA-Z]'; then
	if ask_yn "Add an email for Let's Encrypt expiry/renewal alerts?" "n"; then
		ask ACME_EMAIL "  Email?" ""
		[ -n "$ACME_EMAIL" ] && caddy_set_email "$INSTALL_DIR/docker/Caddyfile" "$ACME_EMAIL" && ok "ACME email set in Caddyfile"
	fi
fi
ok "Domain set to $THALERMARK_DOMAIN"

# --- 7. AI -------------------------------------------------------------------
section "AI features (receipt extraction, expense categorization, cash-flow nudges)"
say "${DIM}AI is configured in the app, not here: sign in and open Settings → AI to pick a"
say "provider (Anthropic / OpenAI / Ollama / custom), paste a key, and click Verify. The"
say "connection is stored encrypted and takes effect with no restart. Until then the AI"
say "endpoints return 503 and the rest of the app runs normally.${R}"
say ""
say "${DIM}If you'll point AI at a private/LAN address (e.g. a local Ollama), enter it below"
say "to allow just that endpoint — leaving the rest of your network blocked. Blank to skip."
say "e.g. http://ollama:11434 or http://192.168.1.10:11434${R}"
ask ALLOWED_ENDPOINT "  Private AI endpoint to allow (optional)?" ""
if [ -n "$ALLOWED_ENDPOINT" ]; then
	kv_set "$ENV_FILE" AI_ALLOWED_ENDPOINTS "$ALLOWED_ENDPOINT"
	ok "Allowed private AI endpoint: $ALLOWED_ENDPOINT"
else
	ok "AI configured in-app (Settings → AI after sign-in)"
fi

# --- 8. email ----------------------------------------------------------------
section "Outbound email (invite/verification/password-reset/invoice emails)"
say "${DIM}1) Resend   2) SMTP   3) None${R}"
say "${YELLOW}Without email, password reset and email verification can't send.${R}"
ask EMAIL_CHOICE "Choose an email method [1-3]?" "3"
case "$EMAIL_CHOICE" in
	1)
		ask_secret RESEND_KEY "  Resend API key (re_...):"
		kv_set "$ENV_FILE" RESEND_API_KEY "$RESEND_KEY"
		ask EMAIL_FROM "  From address?" "Thalermark <hello@$THALERMARK_DOMAIN>"
		kv_set "$ENV_FILE" EMAIL_FROM "$EMAIL_FROM"
		ok "Resend configured" ;;
	2)
		ask SMTP_HOST "  SMTP host?" ""
		ask SMTP_PORT "  SMTP port?" "587"
		ask SMTP_USER "  SMTP username?" ""
		ask_secret SMTP_PASS "  SMTP password:"
		ask_yn "  Use TLS (SMTPS, usually port 465)?" "n" && SMTP_SECURE=true || SMTP_SECURE=false
		ask EMAIL_FROM "  From address?" "Thalermark <hello@$THALERMARK_DOMAIN>"
		kv_set "$ENV_FILE" SMTP_HOST "$SMTP_HOST"
		kv_set "$ENV_FILE" SMTP_PORT "$SMTP_PORT"
		kv_set "$ENV_FILE" SMTP_USER "$SMTP_USER"
		kv_set "$ENV_FILE" SMTP_PASS "$SMTP_PASS"
		kv_set "$ENV_FILE" SMTP_SECURE "$SMTP_SECURE"
		kv_set "$ENV_FILE" EMAIL_FROM "$EMAIL_FROM"
		ok "SMTP configured" ;;
	*)
		warn "No mailer configured — email verification is auto-skipped; password reset is unavailable." ;;
esac

# --- 9. Stripe (optional) ----------------------------------------------------
section "Payments (Stripe pay links on public invoices) — optional"
if ask_yn "Configure Stripe now?" "n"; then
	ask_secret STRIPE_SK "  Stripe secret key (sk_...):"
	ask STRIPE_PK "  Stripe publishable key (pk_...)?" ""
	ask_secret STRIPE_WH "  Stripe webhook signing secret (whsec_...):"
	kv_set "$ENV_FILE" STRIPE_SECRET_KEY "$STRIPE_SK"
	kv_set "$ENV_FILE" STRIPE_PUBLISHABLE_KEY "$STRIPE_PK"
	kv_set "$ENV_FILE" STRIPE_WEBHOOK_SECRET "$STRIPE_WH"
	ok "Stripe configured (webhook endpoint: https://$THALERMARK_DOMAIN/api/webhooks/stripe)"
else
	say "${DIM}Skipped — the Pay button stays hidden until all three Stripe keys are set.${R}"
fi

# --- 10. address autocomplete (optional) -------------------------------------
section "Address autocomplete — optional"
say "${DIM}Defaults to the free, keyless US Census geocoder. A Mapbox token upgrades it.${R}"
if ask_yn "Add a Mapbox access token?" "n"; then
	ask MAPBOX_TOKEN "  Mapbox access token?" ""
	kv_set "$ENV_FILE" MAPBOX_ACCESS_TOKEN "$MAPBOX_TOKEN"
	ok "Mapbox configured"
fi

# --- 11. summary -------------------------------------------------------------
section "Done — configuration written"
ok "Install dir:  $INSTALL_DIR"
ok "Config:       docker/docker-compose.yml, docker/Caddyfile"
ok "Secrets:      $ENV_FILE  ${DIM}(keep this private — it holds all your secrets)${R}"

say ""
say "${B}Next steps:${R}"
say "  1. (optional) Review and tweak settings:"
say "       ${BLUE}\$EDITOR $ENV_FILE${R}"
say "  2. Bring the stack up:"
say "       ${BLUE}cd $INSTALL_DIR && $DC --env-file .env -f docker/docker-compose.yml up -d${R}"
say "  3. Open ${BLUE}https://$THALERMARK_DOMAIN${R}"
if [ "$THALERMARK_DOMAIN" = "localhost" ]; then
	say "     ${DIM}(self-signed cert — your browser warns once; accept and proceed)${R}"
fi
say ""
say "${DIM}Logs:  cd $INSTALL_DIR && $DC --env-file .env -f docker/docker-compose.yml logs -f${R}"
say "${DIM}Stop:  cd $INSTALL_DIR && $DC --env-file .env -f docker/docker-compose.yml down${R}"
say ""
