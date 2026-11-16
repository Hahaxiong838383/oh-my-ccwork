#!/bin/bash
# Explicit archive-mode entry: missing configuration must never silently use keep2.
set -euo pipefail
: "${ANALYTICS_ARCHIVE_ROOT:?archive spool required}"
[[ "$ANALYTICS_ARCHIVE_ROOT" == /* ]] || exit 2
exec /bin/bash "$(dirname "$0")/analytics-maintenance.sh" backup
