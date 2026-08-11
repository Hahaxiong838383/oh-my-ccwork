#!/bin/sh
set -eu
exec </dev/null

project_root=${PROJECT_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/../../../.." && pwd)}
docker_path=${DOCKER_PATH:-docker}
output_root=${OUTPUT_ROOT:-${TMPDIR:-/tmp}/company-si-shadow-release}
source_commit=$(git -C "$project_root" rev-parse HEAD)
upstream_commit=$(git -C "$project_root" rev-parse '@{u}')
[ "$source_commit" = "$upstream_commit" ] || { echo 'HEAD must equal the pushed upstream commit' >&2; exit 1; }
[ -z "$(git -C "$project_root" status --porcelain=v1 -uall -- .)" ] || { echo 'release requires a clean project subtree' >&2; exit 1; }
command -v "$docker_path" >/dev/null 2>&1 || [ -x "$docker_path" ] || { echo 'container runtime unavailable' >&2; exit 2; }

rm -rf "$output_root"
mkdir -p "$output_root"
npm test --prefix "$project_root/packages/ontology-contracts"
npm test --prefix "$project_root/services/intelligence-collector"
npm test --prefix "$project_root/deploy/qnap/strategic-intelligence"
SOURCE_COMMIT="$source_commit" IMAGE_TAG="company-intelligence-collector:$source_commit" DOCKER_PATH="$docker_path" \
  "$project_root/services/intelligence-collector/scripts/build-image.sh"
image_id=$($docker_path image inspect --format '{{.Id}}' "company-intelligence-collector:$source_commit")
case "$image_id" in sha256:*) ;; *) echo 'collector image id is not immutable' >&2; exit 1 ;; esac
PROJECT_ROOT="$project_root" DOCKER_PATH="$docker_path" \
  "$project_root/deploy/qnap/strategic-intelligence/scripts/validate-candidate-migrations-isolated.sh"

git -C "$project_root" archive --format=tar.gz --prefix=company-ai-ontology/ "${source_commit}:2-Projects/company-ai-ontology" > "$output_root/source.tar.gz"
$docker_path save "company-intelligence-collector:$source_commit" | gzip > "$output_root/collector-image.tar.gz"
source_sha=$(shasum -a 256 "$output_root/source.tar.gz" | awk '{print $1}')
image_sha=$(shasum -a 256 "$output_root/collector-image.tar.gz" | awk '{print $1}')
cat > "$output_root/release-manifest.json" <<EOF
{
  "manifestVersion": "1.2.0",
  "releaseType": "P1-SI-F-shadow-candidate-gated",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "sourceCommit": "$source_commit",
  "collectorImageId": "$image_id",
  "sourceArchiveSha256": "$source_sha",
  "collectorImageArchiveSha256": "$image_sha",
  "candidateOntologySchema": "3.7.0",
  "candidateOntologyHash": "c7378774a4e0ca406952e1f1b6515e4ec026347f46533e6662b535407cae1860",
  "sourceRegistryCandidateHash": "0ce4022adcfc177ced670a8d7fd2e4b4e119c2fc1bc5c19cabefb3223c010eae",
  "publish": false,
  "productionDeploymentAuthorized": false,
  "requiredGate": "WAIT_GOAL7_AND_EXPLICIT_DEPLOY_AUTH",
  "p003ReviewGateRequired": true,
  "reviewerRoleAccessGateRequired": true,
  "goal7AcceptanceGateRequired": true
}
EOF
chmod 600 "$output_root/source.tar.gz" "$output_root/collector-image.tar.gz" "$output_root/release-manifest.json"
node "$project_root/deploy/qnap/strategic-intelligence/scripts/validate-release-manifest.mjs" \
  "$output_root/release-manifest.json" "$output_root/source.tar.gz" "$output_root/collector-image.tar.gz" >/dev/null
printf 'shadow_release_candidate=%s\nsource_commit=%s\ncollector_image_id=%s\n' "$output_root" "$source_commit" "$image_id"
