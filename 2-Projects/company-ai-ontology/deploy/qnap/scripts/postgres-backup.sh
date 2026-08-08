#!/bin/sh
set -eu

retention_days=${BACKUP_RETENTION_DAYS:-7}
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
destination=/backups/postgres/base/$timestamp
temporary=${destination}.partial

rm -rf "$temporary"
mkdir -p "$temporary"

pg_basebackup \
  --host="$PGHOST" \
  --port="$PGPORT" \
  --username="$PGUSER" \
  --pgdata="$temporary" \
  --format=plain \
  --wal-method=stream \
  --checkpoint=fast \
  --progress

pg_verifybackup "$temporary"
mv "$temporary" "$destination"
touch "$destination/VERIFIED"

find /backups/postgres/base \
  -mindepth 1 \
  -maxdepth 1 \
  -type d \
  -mtime "+$retention_days" \
  -exec rm -rf {} +

printf 'verified_base_backup=%s\n' "$destination"
