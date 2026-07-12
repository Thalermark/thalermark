#!/bin/sh
# Thalermark self-host backup sidecar.
#
# Dumps once at startup (so you're covered from minute one), then daily at
# BACKUP_AT_HOUR:00 UTC (default 02:00). Writes a timestamped custom-format dump
# to the backups volume, then prunes to the newest BACKUP_KEEP dumps. No cron and
# no extra packages — a transparent sleep loop that sleeps until the next
# scheduled hour, so `docker compose logs backup` shows exactly when each dump
# ran, when the next one is due, and what was pruned.
#
# This is the self-host safety floor: backups land on the SAME host as the
# database, so they survive an application/DB mistake, not a dead disk. For
# off-host durability, bind-mount /backups to a directory your own tooling syncs
# offsite (R2/S3/rsync) — the managed tier is what automates that.
#
# Runs pg_dump from the pgvector/pgvector:pg17 image, so the client version
# matches the server exactly (pg_dump refuses to dump a newer server).
#
# Restore a dump (stops nothing else — restores into the live DB):
#   docker compose cp backup:/backups/<file>.dump ./restore.dump
#   docker compose exec -T postgres pg_restore -U "$POSTGRES_USER" \
#     -d "$POSTGRES_DB" --clean --if-exists < ./restore.dump
set -eu

: "${POSTGRES_USER:=thalermark}"
: "${POSTGRES_DB:=thalermark}"
: "${BACKUP_AT_HOUR:=2}" # UTC hour of the daily dump (0-23)
: "${BACKUP_KEEP:=7}"
DIR=/backups

mkdir -p "$DIR"

while true; do
  # Clear any leftover partials from a previous crash before starting fresh.
  rm -f "$DIR"/.thalermark-*.dump.partial 2>/dev/null || true

  ts=$(date -u +%Y%m%dT%H%M%SZ)
  tmp="$DIR/.thalermark-$ts.dump.partial"
  out="$DIR/thalermark-$ts.dump"

  echo "backup: starting pg_dump at $ts"
  # Dump to a .partial name; only promote to the final name on success, so a
  # crash mid-dump can never leave a truncated file that looks like a backup.
  if pg_dump -h postgres -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f "$tmp"; then
    mv "$tmp" "$out"
    echo "backup: wrote $out"
  else
    echo "backup: pg_dump FAILED — previous backups left untouched" >&2
    rm -f "$tmp"
  fi

  # Prune: keep the newest BACKUP_KEEP completed dumps, delete older ones. Only
  # matches promoted files (thalermark-*.dump), so a failed run can never delete
  # a good backup — it just didn't add a new one.
  ls -1t "$DIR"/thalermark-*.dump 2>/dev/null | tail -n +"$((BACKUP_KEEP + 1))" | while read -r old; do
    echo "backup: pruning $old"
    rm -f "$old"
  done

  # Sleep until the next BACKUP_AT_HOUR:00 UTC. Build an explicit "YYYY-MM-DD
  # HH:00:00" string so GNU date (Debian base image) parses it unambiguously in
  # UTC; if that instant already passed today, target tomorrow. Pure shell — no
  # cron, no packages.
  now=$(date -u +%s)
  target=$(date -u -d "$(date -u +%Y-%m-%d) ${BACKUP_AT_HOUR}:00:00" +%s)
  [ "$target" -le "$now" ] && target=$((target + 86400))
  echo "backup: next dump at $(date -u -d "@$target" +%Y-%m-%dT%H:%M:%SZ)"
  sleep "$((target - now))"
done
