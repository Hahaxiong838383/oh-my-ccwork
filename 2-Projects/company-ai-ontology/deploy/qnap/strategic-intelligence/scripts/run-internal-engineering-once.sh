#!/bin/sh
set -eu
exec </dev/null

[ "${INTERNAL_ENGINEERING_RUN_APPROVED:-NO}" = YES ] || { echo 'explicit internal engineering run approval missing' >&2; exit 1; }
script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_root/preflight-company-qnap.sh"
node_bin=${NODE_BIN:-$script_root/node-runtime.sh}
[ -x "$node_bin" ] || { echo 'internal engineering Node runtime unavailable' >&2; exit 2; }
internal_root=$shadow_root/internal-engineering
project_root=$internal_root/package
package_root=$project_root/deploy/qnap/strategic-intelligence
env_file=$internal_root/.env.internal
[ -d "$project_root/packages/ontology-contracts" ] || { echo 'internal engineering project package missing contracts' >&2; exit 1; }
[ -d "$project_root/services/intelligence-collector" ] || { echo 'internal engineering project package missing collector' >&2; exit 1; }
[ -d "$package_root" ] || { echo 'internal engineering deployment package missing' >&2; exit 1; }
[ -f "$env_file" ] || { echo 'internal engineering env missing' >&2; exit 1; }
[ "$(stat -c '%a' "$env_file")" = 600 ] || { echo 'internal engineering env must be mode 600' >&2; exit 1; }
"$node_bin" "$package_root/scripts/validate-internal-engineering-runtime.mjs" "$internal_root/config" >/dev/null

set -a
. "$env_file"
set +a
[ "${PUBLISH:-}" = false ] || { echo 'PUBLISH must remain false' >&2; exit 1; }
case "$SI_COLLECTOR_IMAGE" in sha256:*|*@sha256:*) ;; *) echo 'collector image must be immutable' >&2; exit 1 ;; esac

run_id=$(date -u +%Y%m%dT%H%M%SZ)
stdout_file=$internal_root/state/$run_id.stdout.json
stderr_file=$internal_root/state/$run_id.stderr.log
container=company-si-internal-$run_id
cd "$package_root"
set +e
"$docker_path" compose --env-file "$env_file" -f docker-compose.shadow.yml --profile worker run \
  --rm --name "$container" --no-deps intelligence-collector >"$stdout_file" 2>"$stderr_file"
exit_code=$?
set -e
[ "$exit_code" -eq 0 ] || { echo 'internal engineering collector run failed' >&2; exit "$exit_code"; }
"$node_bin" -e "const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[1]));if(x.operationMode!=='internal_engineering_shadow'||x.countsTowardProductionShadow!==false||x.publish!==false)process.exit(1)" "$stdout_file"
printf 'internal_engineering_run=succeeded\nrun_id=%s\ncounts_toward_production_shadow=0\nformal_p2=0\nemployee_delivery=0\nerp_writeback=0\nsocial_writeback=0\ncausal_activation=0\n' "$run_id"
