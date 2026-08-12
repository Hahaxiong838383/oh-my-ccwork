#!/bin/sh
set -eu
exec </dev/null
umask 077

[ "${GOAL7_DEPLOY_APPROVED:-}" = YES ] || { echo 'Goal 7 artifact staging requires explicit GOAL7_DEPLOY_APPROVED=YES' >&2; exit 2; }
artifact_id=${GOAL7_APPROVED_ARTIFACT_ID:?GOAL7_APPROVED_ARTIFACT_ID is required}
approved_source_commit=${GOAL7_APPROVED_SOURCE_COMMIT:?GOAL7_APPROVED_SOURCE_COMMIT is required}
approved_h_lite_source_commit=${GOAL7_APPROVED_H_LITE_SOURCE_COMMIT:?GOAL7_APPROVED_H_LITE_SOURCE_COMMIT is required}
case "$artifact_id" in *[!0-9]*|'') echo 'Goal 7 artifact id is unsafe' >&2; exit 2 ;; esac

script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_root/preflight-company-qnap.sh"
node_bin=${NODE_BIN:-$script_root/node-runtime.sh}
[ -x "$node_bin" ] || { echo 'Goal 7 staging Node runtime unavailable' >&2; exit 2; }

incoming_root=$shadow_root/incoming
release_root=$shadow_root/release
incoming=$incoming_root/goal7-$artifact_id.uploading
target=$release_root/goal7-$artifact_id
temporary_target=$target.partial-$$
lock=$release_root/.goal7-$artifact_id.lock
promoted_target=0
case "$incoming:$target" in *'/../'*|*/..:*|*'//'*|*:*'/../'*|*:*/..) echo 'Goal 7 staging path is not normalized' >&2; exit 2 ;; esac
[ -d "$incoming" ] && [ ! -L "$incoming" ] || { echo 'Goal 7 uploaded artifact directory missing or unsafe' >&2; exit 2; }
[ ! -e "$temporary_target" ] || { echo 'Goal 7 staging partial target already exists' >&2; exit 2; }
mkdir -p "$release_root"
chmod 700 "$release_root"
mkdir "$lock" 2>/dev/null || { echo 'Goal 7 artifact staging is already in progress' >&2; exit 2; }

cleanup_stage() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$status" -ne 0 ]; then
    rm -rf "$temporary_target"
    [ "$promoted_target" -eq 0 ] || rm -rf "$target"
  fi
  rmdir "$lock" 2>/dev/null || true
  exit "$status"
}
trap cleanup_stage EXIT
trap 'exit 130' HUP INT TERM

validation=$($node_bin "$script_root/validate-goal7-runtime-release.mjs" \
  "$incoming" "$approved_source_commit" "$approved_h_lite_source_commit")
checksum_count=$(printf '%s\n' "$validation" | awk -F= '/^checksum_entry_count=/{print $2;exit}')
[ "$checksum_count" = 9 ] || { echo 'Goal 7 staged artifact checksum count mismatch' >&2; exit 2; }

mkdir "$temporary_target"
chmod 700 "$temporary_target"
for file in SHA256SUMS runtime-verification.json postgres-validation.txt \
  goal7-foundation-validation.txt release-manifest.json runtime-component-versions.json \
  image.env source.tar.gz h-lite-source.tar.gz collector-image.tar.gz; do
  [ -f "$incoming/$file" ] && [ ! -L "$incoming/$file" ] || { echo "Goal 7 staged artifact file unsafe: $file" >&2; exit 2; }
  cp "$incoming/$file" "$temporary_target/$file"
done
chmod 600 "$temporary_target"/*

$node_bin "$script_root/validate-goal7-runtime-release.mjs" \
  "$temporary_target" "$approved_source_commit" "$approved_h_lite_source_commit" >/dev/null
source_manifest_sha=$(sha256sum "$incoming/SHA256SUMS" | awk '{print $1}')
target_manifest_sha=$(sha256sum "$temporary_target/SHA256SUMS" | awk '{print $1}')
[ "$source_manifest_sha" = "$target_manifest_sha" ] || { echo 'Goal 7 staging checksum manifest drift' >&2; exit 2; }

if [ -e "$target" ]; then
  [ -d "$target" ] && [ ! -L "$target" ] || { echo 'Goal 7 release target is unsafe' >&2; exit 2; }
  $node_bin "$script_root/validate-goal7-runtime-release.mjs" \
    "$target" "$approved_source_commit" "$approved_h_lite_source_commit" >/dev/null
  existing_manifest_sha=$(sha256sum "$target/SHA256SUMS" | awk '{print $1}')
  [ "$existing_manifest_sha" = "$target_manifest_sha" ] || { echo 'Goal 7 release target already binds different artifact bytes' >&2; exit 2; }
  rm -rf "$temporary_target" "$incoming"
  printf 'goal7_artifact_staging=replay_accepted\nartifact_id=%s\nruntime_evidence_root=%s\nchecksum_entry_count=9\n' "$artifact_id" "$target"
  exit 0
fi

mv "$temporary_target" "$target"
promoted_target=1
$node_bin "$script_root/validate-goal7-runtime-release.mjs" \
  "$target" "$approved_source_commit" "$approved_h_lite_source_commit" >/dev/null
rm -rf "$incoming"
printf 'goal7_artifact_staging=completed\nartifact_id=%s\nruntime_evidence_root=%s\nchecksum_entry_count=9\n' "$artifact_id" "$target"
