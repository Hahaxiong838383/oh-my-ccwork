#!/bin/sh
set -eu
exec </dev/null

[ "${SHADOW_DEPLOY_APPROVED:-NO}" = YES ] || { echo 'explicit shadow deployment approval missing' >&2; exit 1; }
[ "${GOAL7_STATUS:-}" = complete ] || { echo 'Goal 7 P1-PROD-READINESS is not complete' >&2; exit 1; }
script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_root/preflight-company-qnap.sh"
node_bin=${NODE_BIN:-$script_root/node-runtime.sh}
[ -x "$node_bin" ] || { echo 'shadow Node runtime unavailable' >&2; exit 2; }
node_runtime_image=${SI_NODE_RUNTIME_IMAGE:?SI_NODE_RUNTIME_IMAGE is required}
case "$node_runtime_image" in sha256:*|*@sha256:*) ;; *) echo 'immutable shadow Node runtime image required' >&2; exit 2 ;; esac
runtime_uid=$(id -u)
runtime_gid=$(id -g)
[ "$runtime_uid" -ne 0 ] || { echo 'shadow runtime must use a non-root deployment account' >&2; exit 1; }

release_root=${SI_RELEASE_ROOT:?SI_RELEASE_ROOT is required}
approved_registry=${SI_APPROVED_SOURCE_REGISTRY_FILE:?SI_APPROVED_SOURCE_REGISTRY_FILE is required}
approved_config=${SI_APPROVED_COLLECTOR_CONFIG_FILE:?SI_APPROVED_COLLECTOR_CONFIG_FILE is required}
approved_p003_review=${SI_APPROVED_P003_REVIEW_FILE:?SI_APPROVED_P003_REVIEW_FILE is required}
reviewer_role_access_acceptance=${SI_REVIEWER_ROLE_ACCESS_ACCEPTANCE_FILE:?SI_REVIEWER_ROLE_ACCESS_ACCEPTANCE_FILE is required}
goal7_acceptance=${SI_GOAL7_ACCEPTANCE_FILE:?SI_GOAL7_ACCEPTANCE_FILE is required}
manifest=$release_root/release-manifest.json
source_archive=$release_root/source.tar.gz
image_archive=$release_root/collector-image.tar.gz
for file in "$manifest" "$source_archive" "$image_archive" "$approved_registry" "$approved_config" "$approved_p003_review" "$reviewer_role_access_acceptance" "$goal7_acceptance"; do
  [ -f "$file" ] || { echo 'required release or approval file missing' >&2; exit 1; }
done
case "$release_root" in /share/CACHEDEV1_DATA/ai-ontology/strategic-intelligence/release/*) ;; *) echo 'refusing unexpected release root' >&2; exit 1 ;; esac
for file in "$approved_registry" "$approved_config" "$approved_p003_review" "$reviewer_role_access_acceptance" "$goal7_acceptance"; do
  case "$file" in "$shadow_root"/approvals/*) ;; *) echo 'approval files must be staged inside the strategic intelligence controlled root' >&2; exit 1 ;; esac
done
"$node_bin" "$script_root/inspect-deployment-readiness.mjs" >/dev/null

source_commit=$("$node_bin" -e "const x=require(process.argv[1]); process.stdout.write(x.sourceCommit)" "$manifest")
image_id=$("$node_bin" -e "const x=require(process.argv[1]); process.stdout.write(x.collectorImageId)" "$manifest")
source_sha=$("$node_bin" -e "const x=require(process.argv[1]); process.stdout.write(x.sourceArchiveSha256)" "$manifest")
image_sha=$("$node_bin" -e "const x=require(process.argv[1]); process.stdout.write(x.collectorImageArchiveSha256)" "$manifest")
[ "$(sha256sum "$source_archive" | awk '{print $1}')" = "$source_sha" ] || { echo 'source archive hash mismatch' >&2; exit 1; }
[ "$(sha256sum "$image_archive" | awk '{print $1}')" = "$image_sha" ] || { echo 'collector image archive hash mismatch' >&2; exit 1; }
"$node_bin" "$script_root/validate-release-manifest.mjs" "$manifest" "$source_archive" "$image_archive" >/dev/null

staging=$release_root/staging-$source_commit
rm -rf "$staging"
mkdir -p "$staging"
tar -C "$staging" -xzf "$source_archive"
release_project_root=$staging/company-ai-ontology
"$node_bin" "$release_project_root/deploy/qnap/strategic-intelligence/scripts/validate-release-manifest.mjs" \
  "$manifest" "$source_archive" "$image_archive" >/dev/null
"$node_bin" "$release_project_root/deploy/qnap/strategic-intelligence/scripts/validate-approved-registry.mjs" "$approved_registry" "$approved_config" >/dev/null
"$node_bin" "$release_project_root/deploy/qnap/strategic-intelligence/scripts/validate-approved-p003-review.mjs" "$approved_p003_review" >/dev/null
reviewer_role_access_evidence_hash=$("$node_bin" "$release_project_root/deploy/qnap/strategic-intelligence/scripts/validate-reviewer-role-access-acceptance.mjs" "$reviewer_role_access_acceptance" | "$node_bin" -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(JSON.parse(s).evidenceHash))")
goal7_evidence_hash=$("$node_bin" "$release_project_root/deploy/qnap/strategic-intelligence/scripts/validate-goal7-acceptance.mjs" "$goal7_acceptance" | "$node_bin" -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(JSON.parse(s).evidenceHash))")

if [ -f "$shadow_root/.env.shadow" ] && [ -d "$shadow_root/package" ]; then
  SI_PACKAGE_ROOT="$shadow_root/package" SI_BACKUP_RUN_ID=pre-shadow-$source_commit "$script_root/backup-shadow.sh" >/dev/null
fi
gzip -dc "$image_archive" | "$docker_path" load >/dev/null
"$docker_path" image inspect "$image_id" >/dev/null

mkdir -p "$shadow_root/config" "$shadow_root/state/queue" "$shadow_root/state/collector" "$shadow_root/reports" "$shadow_root/evidence" "$shadow_root/release"
chmod 750 "$shadow_root" "$shadow_root/config" "$shadow_root/state" "$shadow_root/state/queue" "$shadow_root/state/collector" "$shadow_root/reports" "$shadow_root/evidence" "$shadow_root/release"
rm -rf "$shadow_root/package.next"
cp -R "$release_project_root/deploy/qnap/strategic-intelligence" "$shadow_root/package.next"
cp "$approved_registry" "$shadow_root/config/source-registry.json"
cp "$approved_config" "$shadow_root/config/collector.json"
cp "$approved_p003_review" "$shadow_root/config/p003-review.json"
chmod 640 "$shadow_root/config/source-registry.json" "$shadow_root/config/collector.json" "$shadow_root/config/p003-review.json"
umask 077
cat > "$shadow_root/.env.shadow" <<EOF
SI_STATE_ROOT=$shadow_root/state
SI_REPORT_ROOT=$shadow_root/reports
SI_COLLECTOR_CONFIG_FILE=$shadow_root/config/collector.json
SI_SOURCE_REGISTRY_FILE=$shadow_root/config/source-registry.json
SI_P003_REVIEW_FILE=$shadow_root/config/p003-review.json
SI_COLLECTOR_IMAGE=$image_id
SI_SOURCE_COMMIT=$source_commit
SI_NODE_RUNTIME_IMAGE=$node_runtime_image
SI_PERSIST_DOMAIN_TO_POSTGRES=YES
SI_ORCHESTRATOR_UID=$runtime_uid
SI_ORCHESTRATOR_GID=$runtime_gid
SI_COLLECTOR_UID=$runtime_uid
SI_COLLECTOR_GID=$runtime_gid
FOUNDATION_DATA_NETWORK=company-ai-foundation_data
PUBLISH=false
SHADOW_AUTO_ROLLBACK_APPROVED=NO
SI_ROLLBACK_BACKUP_ROOT=
EOF
chmod 600 "$shadow_root/.env.shadow"

SI_RELEASE_PROJECT_ROOT="$release_project_root" "$release_project_root/deploy/qnap/strategic-intelligence/scripts/apply-shadow-migrations.sh"
package_root=$shadow_root/package.next
cd "$package_root"
"$docker_path" compose --env-file "$shadow_root/.env.shadow" -f docker-compose.shadow.yml config >/dev/null
rm -rf "$shadow_root/package.previous"
[ ! -d "$shadow_root/package" ] || mv "$shadow_root/package" "$shadow_root/package.previous"
mv "$shadow_root/package.next" "$shadow_root/package"
package_root=$shadow_root/package
rm -f "$shadow_root/FROZEN"
"$docker_path" compose --env-file "$shadow_root/.env.shadow" -f "$package_root/docker-compose.shadow.yml" up -d --no-deps intelligence-orchestrator
"$package_root/scripts/install-dispatcher-cron.sh"
container_id=$($docker_path compose --env-file "$shadow_root/.env.shadow" -f "$package_root/docker-compose.shadow.yml" ps -q intelligence-orchestrator)
[ -n "$container_id" ] || { echo 'orchestrator container missing' >&2; exit 1; }
[ "$($docker_path inspect --format '{{.RestartCount}}' "$container_id")" = 0 ] || { echo 'orchestrator restarted unexpectedly' >&2; exit 1; }
published_ports=$($docker_path inspect --format '{{json .NetworkSettings.Ports}}' "$container_id")
[ "$published_ports" = null ] || [ "$published_ports" = '{}' ] || { echo 'orchestrator unexpectedly publishes ports' >&2; exit 1; }
printf 'strategic_intelligence_shadow=deployed\nsource_commit=%s\ncollector_image=%s\nreviewer_role_access_evidence_hash=%s\ngoal7_evidence_hash=%s\nrestart_count=0\nnew_host_ports=0\n' "$source_commit" "$image_id" "$reviewer_role_access_evidence_hash" "$goal7_evidence_hash"
