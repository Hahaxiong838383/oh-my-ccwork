#!/bin/sh
set -eu
exec </dev/null

[ "${INTERNAL_ENGINEERING_SHADOW_DEPLOY_APPROVED:-NO}" = YES ] || { echo 'explicit internal engineering deployment approval missing' >&2; exit 1; }
script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_root/preflight-company-qnap.sh"
node_runtime_image=${SI_NODE_RUNTIME_IMAGE:?SI_NODE_RUNTIME_IMAGE is required}
case "$node_runtime_image" in sha256:*|*@sha256:*) ;; *) echo 'QNAP Node runtime image must be immutable' >&2; exit 1 ;; esac
node_bin=${NODE_BIN:-$script_root/node-runtime.sh}
[ -x "$node_bin" ] || { echo 'internal engineering Node runtime unavailable' >&2; exit 2; }
runtime_uid=$(id -u)
runtime_gid=$(id -g)
[ "$runtime_uid" -ne 0 ] || { echo 'internal engineering runtime must use a non-root deployment account' >&2; exit 1; }

release_root=${SI_RELEASE_ROOT:?SI_RELEASE_ROOT is required}
runtime_root=${SI_INTERNAL_RUNTIME_ROOT:?SI_INTERNAL_RUNTIME_ROOT is required}
internal_root=$shadow_root/internal-engineering
manifest=$release_root/release-manifest.json
source_archive=$release_root/source.tar.gz
image_archive=$release_root/collector-image.tar.gz
for file in "$manifest" "$source_archive" "$image_archive" \
  "$runtime_root/internal-engineering-plan.json" "$runtime_root/source-registry.json" \
  "$runtime_root/collector.json" "$runtime_root/runtime-manifest.json"; do
  [ -f "$file" ] || { echo 'required internal engineering release file missing' >&2; exit 1; }
done
case "$release_root" in /share/CACHEDEV1_DATA/ai-ontology/strategic-intelligence/release/*) ;; *) echo 'refusing unexpected release root' >&2; exit 1 ;; esac
case "$runtime_root" in /share/CACHEDEV1_DATA/ai-ontology/strategic-intelligence/internal-runtime/*) ;; *) echo 'refusing unexpected internal runtime root' >&2; exit 1 ;; esac

"$node_bin" "$script_root/validate-internal-engineering-runtime.mjs" "$runtime_root" >/dev/null
COMPANY_QNAP_PREFLIGHT_VERIFIED=YES "$node_bin" "$script_root/inspect-internal-engineering-readiness.mjs" >/dev/null

source_commit=$("$node_bin" -e "const x=require(process.argv[1]); process.stdout.write(x.sourceCommit)" "$manifest")
image_id=$("$node_bin" -e "const x=require(process.argv[1]); process.stdout.write(x.collectorImageId)" "$manifest")
source_sha=$("$node_bin" -e "const x=require(process.argv[1]); process.stdout.write(x.sourceArchiveSha256)" "$manifest")
image_sha=$("$node_bin" -e "const x=require(process.argv[1]); process.stdout.write(x.collectorImageArchiveSha256)" "$manifest")
[ "$(sha256sum "$source_archive" | awk '{print $1}')" = "$source_sha" ] || { echo 'source archive hash mismatch' >&2; exit 1; }
[ "$(sha256sum "$image_archive" | awk '{print $1}')" = "$image_sha" ] || { echo 'collector image archive hash mismatch' >&2; exit 1; }
"$node_bin" "$script_root/validate-release-manifest.mjs" "$manifest" "$source_archive" "$image_archive" >/dev/null

staging=$release_root/internal-staging-$source_commit
rm -rf "$staging"
mkdir -p "$staging"
tar -C "$staging" -xzf "$source_archive"
release_project_root=$staging/company-ai-ontology
"$node_bin" "$release_project_root/deploy/qnap/strategic-intelligence/scripts/validate-internal-engineering-runtime.mjs" "$runtime_root" >/dev/null

backup_id=$(date -u +%Y%m%dT%H%M%SZ)
backup_root=/share/CACHEDEV2_DATA/ai-ontology-backup/strategic-intelligence/internal-engineering/$backup_id
umask 077
mkdir -p "$backup_root"
if [ -d "$internal_root/package" ] || [ -d "$internal_root/config" ] || [ -f "$internal_root/.env.internal" ]; then
  tar -C "$internal_root" -czf "$backup_root/previous-runtime.tar.gz" \
    $(for entry in package config .env.internal; do [ ! -e "$internal_root/$entry" ] || printf '%s ' "$entry"; done)
  [ -s "$backup_root/previous-runtime.tar.gz" ] || { echo 'internal engineering backup archive is empty' >&2; exit 1; }
  tar -tzf "$backup_root/previous-runtime.tar.gz" >/dev/null
  tar -tzf "$backup_root/previous-runtime.tar.gz" | grep -q '^package/' || { echo 'internal engineering backup missing package' >&2; exit 1; }
  tar -tzf "$backup_root/previous-runtime.tar.gz" | grep -q '^config/' || { echo 'internal engineering backup missing config' >&2; exit 1; }
  tar -tzf "$backup_root/previous-runtime.tar.gz" | grep -q '^\.env\.internal$' || { echo 'internal engineering backup missing env' >&2; exit 1; }
  (cd "$backup_root" && sha256sum previous-runtime.tar.gz > previous-runtime.tar.gz.sha256 && sha256sum -c previous-runtime.tar.gz.sha256 >/dev/null)
fi

gzip -dc "$image_archive" | "$docker_path" load >/dev/null
"$docker_path" image inspect "$image_id" >/dev/null

mkdir -p "$internal_root/config" "$internal_root/state/collector" "$internal_root/reports" "$internal_root/release"
chmod 750 "$internal_root" "$internal_root/config" "$internal_root/state" "$internal_root/state/collector" "$internal_root/reports" "$internal_root/release"
rm -rf "$internal_root/package.next"
cp -R "$release_project_root" "$internal_root/package.next"
cp "$runtime_root/internal-engineering-plan.json" "$internal_root/config/internal-engineering-plan.json"
cp "$runtime_root/source-registry.json" "$internal_root/config/source-registry.json"
cp "$runtime_root/collector.json" "$internal_root/config/collector.json"
cp "$runtime_root/runtime-manifest.json" "$internal_root/config/runtime-manifest.json"
chmod 600 "$internal_root/config/"*.json
cat > "$internal_root/.env.internal" <<EOF
SI_STATE_ROOT=$internal_root/state
SI_REPORT_ROOT=$internal_root/reports
SI_COLLECTOR_CONFIG_FILE=$internal_root/config/collector.json
SI_SOURCE_REGISTRY_FILE=$internal_root/config/source-registry.json
SI_INTERNAL_ENGINEERING_PLAN_FILE=$internal_root/config/internal-engineering-plan.json
SI_COLLECTOR_IMAGE=$image_id
SI_SOURCE_COMMIT=$source_commit
SI_NODE_RUNTIME_IMAGE=$node_runtime_image
SI_ORCHESTRATOR_UID=$runtime_uid
SI_ORCHESTRATOR_GID=$runtime_gid
SI_COLLECTOR_UID=$runtime_uid
SI_COLLECTOR_GID=$runtime_gid
FOUNDATION_DATA_NETWORK=company-ai-foundation_data
PUBLISH=false
SHADOW_AUTO_ROLLBACK_APPROVED=NO
SI_ROLLBACK_BACKUP_ROOT=
EOF
chmod 600 "$internal_root/.env.internal"

package_root=$internal_root/package.next/deploy/qnap/strategic-intelligence
cd "$package_root"
"$docker_path" compose --env-file "$internal_root/.env.internal" -f docker-compose.shadow.yml config >/dev/null
rm -rf "$internal_root/package.previous"
[ ! -d "$internal_root/package" ] || mv "$internal_root/package" "$internal_root/package.previous"
mv "$internal_root/package.next" "$internal_root/package"
printf '%s\n' "$backup_root" > "$internal_root/.previous-backup"
chmod 600 "$internal_root/.previous-backup"

printf 'internal_engineering_runtime=prepared\nsource_commit=%s\ncollector_image=%s\ncontainer_started=0\ndatabase_migration_count=0\nexisting_service_restart_count=0\nbackup_root=%s\n' \
  "$source_commit" "$image_id" "$backup_root"
