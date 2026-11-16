#!/bin/sh
# Five-minute scheduler entry; no daemon, no device request waits for this task.
set -efu
: "${ARCHIVE_ROOT:?}"
archive_scripts=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "${ARCHIVE_PYTHON:-python3}" "$archive_scripts/storage-lock.py" "$ARCHIVE_ROOT/.cycle.lock" /bin/sh "$archive_scripts/storage-nas-cycle-body.sh"
