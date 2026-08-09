#!/bin/sh
set -eu
exec </dev/null

docker_path=/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker
project_root=${PROJECT_ROOT:-/share/CACHEDEV1_DATA/ai-ontology/foundation}
source_commit=${ONTOLOGY_SOURCE_COMMIT:?ONTOLOGY_SOURCE_COMMIT is required}
proposal_id=${ONTOLOGY_PROPOSAL_ID:?ONTOLOGY_PROPOSAL_ID is required}
approved_by=${ONTOLOGY_APPROVED_BY:?ONTOLOGY_APPROVED_BY is required}

case "$source_commit" in
  *[!0-9a-fA-F]*|'') echo 'ONTOLOGY_SOURCE_COMMIT must be a Git commit hash' >&2; exit 2 ;;
esac
[ "${#source_commit}" -ge 7 ] || { echo 'ONTOLOGY_SOURCE_COMMIT must contain at least 7 hex characters' >&2; exit 2; }

cd "$project_root"
set -a
. ./.env
set +a

"$docker_path" compose exec -T \
  -e ONTOLOGY_SOURCE_COMMIT="$source_commit" \
  -e ONTOLOGY_PROPOSAL_ID="$proposal_id" \
  -e ONTOLOGY_APPROVED_BY="$approved_by" \
  ontology-registry node --input-type=module - <<'NODE'
const body = JSON.stringify({
  sourceCommit: process.env.ONTOLOGY_SOURCE_COMMIT,
  proposalId: process.env.ONTOLOGY_PROPOSAL_ID,
  approvedBy: process.env.ONTOLOGY_APPROVED_BY,
})
const response = await fetch('http://127.0.0.1:8084/v1/deploy', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-ontology-registry-token': process.env.ONTOLOGY_REGISTRY_CONTROL_TOKEN,
  },
  body,
})
const payload = await response.json()
console.log(JSON.stringify(payload))
if (!response.ok || !['deployed', 'reactivated', 'already_active'].includes(payload.status)) process.exit(1)
NODE

"$docker_path" compose exec -T ontology-registry node --input-type=module - <<'NODE'
const response = await fetch('http://127.0.0.1:8084/readyz')
const payload = await response.json()
console.log(JSON.stringify(payload))
if (!response.ok || payload.status !== 'in_sync') process.exit(1)
NODE
