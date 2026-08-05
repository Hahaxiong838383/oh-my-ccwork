#!/usr/bin/env bash
set -euo pipefail

deploy_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$deploy_dir"

set -a
source .env
set +a

docker compose --env-file .env ps

docker compose --env-file .env exec -T backend \
  bash -lc 'bench --site "${SITE_NAME}" list-apps'

docker compose --env-file .env exec -T backend \
  bash -lc 'bench --site "${SITE_NAME}" execute aishike_erp.acceptance.runtime_check'

curl -fsS \
  -H "Host: ${SITE_NAME}" \
  "http://127.0.0.1:${HTTP_PUBLISH_PORT}/api/method/ping"
printf '\n'
