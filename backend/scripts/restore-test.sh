#!/usr/bin/env bash
# restore-test.sh — the restore drill: load a backup into a SCRATCH database, check it, and time it (this is your RTO evidence).
#   Usage:  TARGET_URL=postgresql://user:pass@host:5432/triplee_restore_test  ./scripts/restore-test.sh backups/triplee-YYYYMMDD-HHMMSS.dump
#   NEVER point TARGET_URL at the live database: --clean drops objects before restoring them.
set -euo pipefail
FILE="${1:?Give the backup file}"; : "${TARGET_URL:?Set TARGET_URL to an empty scratch database}"
[ -f "$FILE.sha256" ] && ( cd "$(dirname "$FILE")" && sha256sum -c "$(basename "$FILE").sha256" )
START="$(date +%s)"
pg_restore --no-owner --clean --if-exists --dbname "$TARGET_URL" "$FILE"
ELAPSED=$(( $(date +%s) - START ))
echo "--- restored in ${ELAPSED}s. Row counts:"
for t in users products stock_movements audit_log; do
  printf '%-18s' "$t"; psql "$TARGET_URL" -Atc "SELECT count(*) FROM $t" || echo "(missing)"
done
echo "Write down: backup file, date and time, ${ELAPSED}s, who ran it. That record is your evidence for the recovery test (T-15)."
