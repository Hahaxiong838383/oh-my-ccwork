#!/bin/sh
set -eu

if command -v node >/dev/null 2>&1; then
  exec node "$@"
fi

docker_path=${DOCKER_PATH:-/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker}
mount_root=${SI_NODE_RUNTIME_MOUNT_ROOT:-/share/CACHEDEV1_DATA/ai-ontology/strategic-intelligence}
node_image=${SI_NODE_RUNTIME_IMAGE:-}

[ -x "$docker_path" ] || { echo 'QNAP Node container runtime unavailable' >&2; exit 2; }
[ -d "$mount_root" ] || { echo 'QNAP Node runtime mount root missing' >&2; exit 2; }
case "$mount_root" in /share/CACHEDEV1_DATA/ai-ontology/strategic-intelligence) ;; *) echo 'refusing unexpected QNAP Node runtime mount root' >&2; exit 2 ;; esac
case "$node_image" in sha256:*|*@sha256:*) ;; *) echo 'immutable QNAP Node runtime image required' >&2; exit 2 ;; esac

runtime_uid=$(id -u)
runtime_gid=$(id -g)
[ "$runtime_uid" -ne 0 ] || { echo 'QNAP Node runtime must use a non-root account' >&2; exit 2; }

exec "$docker_path" run -i --rm \
  --network none \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 64 \
  --memory 256m \
  --cpus 0.5 \
  --user "$runtime_uid:$runtime_gid" \
  --workdir "$mount_root" \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m \
  -e COMPANY_QNAP_PREFLIGHT_VERIFIED \
  -e GOAL7_STATUS \
  -e INTERNAL_ENGINEERING_SHADOW_DEPLOY_APPROVED \
  -e INTERNAL_ENGINEERING_RUN_APPROVED \
  -e SHADOW_DEPLOY_APPROVED \
  -e SI_APPROVED_COLLECTOR_CONFIG_FILE \
  -e SI_APPROVED_P003_REVIEW_FILE \
  -e SI_APPROVED_SOURCE_REGISTRY_FILE \
  -e SI_GOAL7_ACCEPTANCE_FILE \
  -e SI_INTERNAL_ENGINEERING_PLAN_FILE \
  -e SI_INTERNAL_RUNTIME_ROOT \
  -e SI_RELEASE_ROOT \
  -e SI_REVIEWER_ROLE_ACCESS_ACCEPTANCE_FILE \
  -e TZ \
  -v "$mount_root:$mount_root:rw" \
  --entrypoint node \
  "$node_image" \
  "$@"
