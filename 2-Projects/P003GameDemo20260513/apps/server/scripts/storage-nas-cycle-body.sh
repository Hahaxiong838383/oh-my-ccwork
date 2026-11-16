#!/bin/sh
set -efu
umask 077
: "${ARCHIVE_ROOT:?}" "${ARCHIVE_VERIFY:?}" "${ARCHIVE_SSH_CONFIG:?}" "${ARCHIVE_SSH_TARGET:?}"
archive_scripts=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
archive_list="$ARCHIVE_ROOT/.list.$$"
archive_queue="$ARCHIVE_ROOT/.queue.$$"
archive_phase=list
cycle_cleanup() {
  archive_exit=$?
  rm -f "$archive_list" "$archive_queue"
  "$ARCHIVE_VERIFY" status "$ARCHIVE_ROOT" "$archive_exit" "$archive_phase" || true
}
trap cycle_cleanup EXIT
trap 'exit 130' INT TERM HUP
ssh -n -F "$ARCHIVE_SSH_CONFIG" -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=8 -o ServerAliveInterval=10 -o ServerAliveCountMax=2 "$ARCHIVE_SSH_TARGET" list > "$archive_list"
"$ARCHIVE_VERIFY" queue "$ARCHIVE_ROOT" "$archive_list" > "$archive_queue"
archive_phase=transfer
while IFS= read -r archive_id; do
  [ -n "$archive_id" ] || continue
  /bin/sh "$archive_scripts/storage-nas-pull.sh" "$archive_id"
done < "$archive_queue"
archive_phase=rotate
# Serialize rotation with manual pulls too; never rotate beneath a live writer.
"${ARCHIVE_PYTHON:-python3}" "$archive_scripts/storage-lock.py" "$ARCHIVE_ROOT/.pull.lock" "$ARCHIVE_VERIFY" rotate "$ARCHIVE_ROOT"
archive_phase=complete
