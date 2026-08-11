#!/bin/sh
set -eu
exec </dev/null

[ "${SI_PERSIST_DOMAIN_TO_POSTGRES:-NO}" = YES ] || { echo 'Postgres domain persistence is not enabled' >&2; exit 1; }
batch_file=${1:?domain batch file is required}
metrics_file=${2:?domain metrics file is required}
[ -f "$batch_file" ] || { echo 'domain batch file missing' >&2; exit 1; }
[ -f "$metrics_file" ] || { echo 'domain metrics file missing' >&2; exit 1; }
script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_root/preflight-company-qnap.sh" >/dev/null
node_bin=${NODE_BIN:-$script_root/node-runtime.sh}
[ -x "$node_bin" ] || { echo 'shadow persistence Node runtime unavailable' >&2; exit 2; }
sql_file=$shadow_root/state/$(basename "$batch_file").persist.sql
result_file=$shadow_root/state/$(basename "$batch_file").persist.result
trap 'rm -f "$sql_file" "$result_file"' EXIT INT TERM
"$node_bin" "$script_root/compile-shadow-domain-sql.mjs" "$batch_file" "$sql_file" >/dev/null

cd "$foundation_root"
set -a
. ./.env
set +a
"$docker_path" compose exec -T postgres psql \
  --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 \
  --username ontology_admin --dbname ontology \
  --set=tenant_id="$FUTURUS_TENANT_ID" \
  < "$sql_file" > "$result_file"

result=$(tail -n 1 "$result_file")
"$node_bin" - "$metrics_file" "$result" <<'NODE'
const fs = require('node:fs')
const file = process.argv[2]
const result = JSON.parse(process.argv[3])
if (result.persisted !== true || result.persistenceState !== 'postgres_committed') throw new Error('Postgres persistence result invalid')
const metrics = JSON.parse(fs.readFileSync(file, 'utf8'))
metrics.persisted = true
metrics.persistenceState = result.persistenceState
metrics.persistenceBatchHash = result.batchHash
fs.writeFileSync(file, `${JSON.stringify(metrics, null, 2)}\n`, { mode: 0o600 })
NODE
