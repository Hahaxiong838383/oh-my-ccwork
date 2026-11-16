#!/bin/sh
# Kernel lock survives exec/fork; an orphan SSH writer still excludes the next job.
set -efu
: "${ARCHIVE_ROOT:?}"
archive_scripts=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "${ARCHIVE_PYTHON:-python3}" "$archive_scripts/storage-lock.py" "$ARCHIVE_ROOT/.pull.lock" /bin/sh "$archive_scripts/storage-nas-transfer.sh" "$@"
