#!/bin/sh
# One package, one SSH transfer. Requires a private, pre-created canonical root.
# The verifier is a local executable wrapper (native Node or pinned offline container).
set -efu
umask 077
: "${ARCHIVE_ROOT:?}" "${ARCHIVE_VERIFY:?}" "${ARCHIVE_SSH_CONFIG:?}" "${ARCHIVE_SSH_TARGET:?}"
archive_id="${1:?archive id required}"
case "$archive_id" in *[!a-f0-9]*|'') exit 2;; esac
[ "${#archive_id}" -eq 32 ] || exit 2
case "$ARCHIVE_SSH_TARGET" in -*|*' '*) exit 2;; esac
[ -d "$ARCHIVE_ROOT" ] && [ ! -L "$ARCHIVE_ROOT" ] || exit 2
archive_meta="$ARCHIVE_ROOT/.manifest.$$"
archive_ack="$ARCHIVE_ROOT/.ack.$$"
archive_child=''
cleanup() {
  if [ -n "$archive_child" ]; then kill "$archive_child" 2>/dev/null || true; fi
  rm -f "$archive_meta" "$archive_ack" "$ARCHIVE_ROOT/.transfer.pid"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP
remote() { ssh -n -F "$ARCHIVE_SSH_CONFIG" -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=8 -o ServerAliveInterval=10 -o ServerAliveCountMax=2 "$ARCHIVE_SSH_TARGET" "$@"; }
remote meta "$archive_id" > "$archive_meta"
archive_fields=$("$ARCHIVE_VERIFY" prepare "$ARCHIVE_ROOT" "$archive_meta")
IFS="$(printf '\t')" read -r archive_return_id archive_sha archive_size archive_offset archive_complete archive_count <<EOF
$archive_fields
EOF
[ "$archive_return_id" = "$archive_id" ] || exit 2
case "$archive_offset" in *[!0-9]*|'') exit 2;; esac
printf 'ARCHIVE_TRANSFER id=%s resume_offset=%s total=%s\n' "$archive_id" "$archive_offset" "$archive_size"
if [ "$archive_complete" != 1 ]; then
  # Start the external ssh directly so $! is the transport PID, not a subshell.
  ssh -n -F "$ARCHIVE_SSH_CONFIG" -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=8 -o ServerAliveInterval=10 -o ServerAliveCountMax=2 "$ARCHIVE_SSH_TARGET" read "$archive_id" "$archive_offset" >> "$ARCHIVE_ROOT/incoming/$archive_id/payload.bin" &
  archive_child=$!
  printf '%s\n' "$archive_child" > "$ARCHIVE_ROOT/.transfer.pid"
  if wait "$archive_child"; then archive_child=''; else archive_child=''; exit 4; fi
fi
"$ARCHIVE_VERIFY" finalize "$ARCHIVE_ROOT" "$archive_id"
# Final directory and payload have been fsynced before this remote receipt.
# If SSH loses the acknowledgement, rerunning the same ID rehashes and retries it.
remote ack "$archive_id" "$archive_sha" "$archive_size" "$archive_count" > "$archive_ack"
"$ARCHIVE_VERIFY" ack "$ARCHIVE_ROOT" "$archive_id" "$archive_ack"
printf 'ARCHIVE_VERIFIED id=%s bytes=%s\n' "$archive_id" "$archive_size"
