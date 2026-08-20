#!/bin/bash
# Nightly Postgres dump, verified, then copied off the host.
#
# Installed at /opt/lilypad/backup.sh on the production VM and run from cron at
# 03:17 UTC. Two things the original version did not do:
#
#  1. **Verify before publishing.** It wrote `pg_dump | gzip` straight to the
#     final filename. A dump that died halfway still leaves a valid gzip file
#     with a plausible name and a fresh mtime, so every age-based check —
#     including the watchdog's — believes a backup happened. The dump is now
#     written to a temporary name, checked for pg_dump's completion marker, and
#     only then moved into place. The move is atomic, so a reader never sees a
#     partial file under the real name.
#
#  2. **Keep a copy somewhere else.** Backups lived on the same disk as the
#     database they protect. Losing the VM lost both — and Oracle's Always Free
#     terms permit reclaiming an idle instance, so "lose the VM" is a documented
#     scenario rather than a hypothetical. A copy now goes to the relay VM,
#     which is a different machine with a different disk and a different
#     failure mode.
set -euo pipefail

OUT=/opt/lilypad/infra/production/backups
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
TMP="$OUT/.lilypad-$STAMP.sql.gz.partial"
FINAL="$OUT/lilypad-$STAMP.sql.gz"
OFFSITE_KEY=/root/.ssh/lilypad-offsite
OFFSITE_HOST=${OFFSITE_HOST:-}

mkdir -p "$OUT"
trap 'rm -f "$TMP"' EXIT

docker exec lilypad-prod-postgres-1 pg_dump -U lilypad -d lilypad | gzip > "$TMP"

# pg_dump writes this as its last line only on a clean finish.
if ! gzip -dc "$TMP" | tail -5 | grep -q 'PostgreSQL database dump complete'; then
  echo "$(date -u +%FT%TZ) FAILED: dump is incomplete — not publishing it" >&2
  exit 1
fi

mv "$TMP" "$FINAL"
trap - EXIT
chmod 600 "$FINAL"
echo "$(date -u +%FT%TZ) local: $(basename "$FINAL") ($(stat -c%s "$FINAL") bytes)"

find "$OUT" -name 'lilypad-*.sql.gz' -mtime +7 -delete
find "$OUT" -name '.lilypad-*.partial' -mmin +60 -delete

# Off-host copy. Non-fatal on its own — a local backup that exists is worth
# more than a script that aborted — but it is loud, and the watchdog alerts
# separately when the offsite copy goes stale.
if [ -n "$OFFSITE_HOST" ] && [ -r "$OFFSITE_KEY" ]; then
  if ssh -i "$OFFSITE_KEY" -o BatchMode=yes -o ConnectTimeout=20 \
       -o StrictHostKeyChecking=yes "$OFFSITE_HOST" < "$FINAL"; then
    echo "$(date -u +%FT%TZ) offsite: copied"
  else
    echo "$(date -u +%FT%TZ) WARNING: offsite copy failed" >&2
  fi
else
  echo "$(date -u +%FT%TZ) WARNING: offsite copy not configured" >&2
fi
