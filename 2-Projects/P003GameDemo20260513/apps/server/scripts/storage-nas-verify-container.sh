#!/bin/sh
# Offline verifier; the container itself holds a kernel lock even if Docker CLI dies.
set -efu
: "${ARCHIVE_ROOT:?}" "${ARCHIVE_CODE_ROOT:?}" "${ARCHIVE_DOCKER:?}" "${ARCHIVE_NODE_IMAGE:?}"
[ -d "$ARCHIVE_ROOT" ] && [ ! -L "$ARCHIVE_ROOT" ] || exit 2
[ -d "$ARCHIVE_CODE_ROOT" ] && [ ! -L "$ARCHIVE_CODE_ROOT" ] || exit 2
case "$ARCHIVE_NODE_IMAGE" in sha256:*) ;; *) exit 2;; esac
exec "$ARCHIVE_DOCKER" run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --user 1000:100 --cpus=1.5 --memory=512m --pids-limit=64 \
  -e "ARCHIVE_NAS_BUDGET_BYTES=${ARCHIVE_NAS_BUDGET_BYTES:-1099511627776}" \
  -e "ARCHIVE_NAS_RESERVE_BYTES=${ARCHIVE_NAS_RESERVE_BYTES:-4294967296}" \
  -v "$ARCHIVE_CODE_ROOT:/code:ro" -v "$ARCHIVE_ROOT:$ARCHIVE_ROOT" \
  --entrypoint /usr/bin/timeout "$ARCHIVE_NODE_IMAGE" -k 10 7200 \
  /usr/bin/flock -n "$ARCHIVE_ROOT/.verify.lock" node /code/storage-nas-verify.mjs "$@"
