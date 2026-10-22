#!/usr/bin/env bash
# backup.sh — a compressed, checksummed copy of the TRIPLE-E database, and removal of copies older than N days.
#   Usage:  DATABASE_URL=postgresql://user:pass@host:5432/db  ./scripts/backup.sh [folder] [keep_days]
#   Or set the standard PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE variables instead of DATABASE_URL.
#   Hosted databases (Supabase) need  PGSSLMODE=require  or  ?sslmode=require  on the URL.
#   Schedule it daily (cron, Windows Task Scheduler, Cloud Scheduler job or a GitHub Actions cron).
set -euo pipefail
OUT="${1:-./backups}"; KEEP="${2:-14}"
mkdir -p "$OUT"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$OUT/triplee-$STAMP.dump"
START="$(date +%s)"
if [ -n "${DATABASE_URL:-}" ]; then pg_dump --format=custom --no-owner --file "$FILE" "$DATABASE_URL"
else pg_dump --format=custom --no-owner --file "$FILE"; fi
( cd "$OUT" && sha256sum "$(basename "$FILE")" > "$(basename "$FILE").sha256" )
find "$OUT" -name 'triplee-*.dump*' -mtime +"$KEEP" -delete
echo "Backup written: $FILE ($(du -h "$FILE" | cut -f1)) in $(( $(date +%s) - START )) s. Kept the last $KEEP days."
echo "Store a copy OFF this machine (another cloud bucket or drive). A backup on the same server is not a backup."
