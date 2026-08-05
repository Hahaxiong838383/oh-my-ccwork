#!/usr/bin/env bash
set -euo pipefail

deploy_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$deploy_dir/.." && pwd)"
cd "$deploy_dir"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker 未安装，请先运行 deploy/prepare-host.sh。" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "当前用户无权访问 Docker，请重新登录后再运行。" >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 不可用。" >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
fi

set -a
source .env
set +a

LOCAL_TUNNEL_PORT="${LOCAL_TUNNEL_PORT:-18081}"

mkdir -p secrets backups
chmod 700 secrets backups

generate_secret() {
  local target="$1"
  if [[ ! -s "$target" ]]; then
    umask 077
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n' >"$target"
    printf '\n' >>"$target"
  fi
  chmod 600 "$target"
}

generate_secret secrets/db_root_password.txt
generate_secret secrets/admin_password.txt

docker build \
  --build-arg "ERPNEXT_IMAGE=${ERPNEXT_IMAGE}" \
  --file "$deploy_dir/Containerfile" \
  --tag "${CUSTOM_IMAGE}:${CUSTOM_TAG}" \
  "$project_root"

docker compose --env-file .env up -d

for attempt in $(seq 1 60); do
  if docker compose --env-file .env exec -T backend bench version >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" == "60" ]]; then
    echo "ERPNext 后端未在预期时间内就绪。" >&2
    docker compose --env-file .env ps >&2
    exit 1
  fi
  sleep 5
done

if ! docker compose --env-file .env exec -T backend \
  bash -lc 'test -d "sites/${SITE_NAME}"'; then
  docker compose --env-file .env exec -T backend bash -lc '
    bench new-site \
      --mariadb-user-host-login-scope="%" \
      --db-root-username=root \
      --db-root-password="$(cat /run/secrets/db_root_password)" \
      --admin-password="$(cat /run/secrets/admin_password)" \
      --install-app erpnext \
      --set-default \
      "${SITE_NAME}"
  '
fi

if ! docker compose --env-file .env exec -T backend \
  bash -lc 'bench --site "${SITE_NAME}" list-apps | grep -q "^aishike_erp"'; then
  docker compose --env-file .env exec -T backend \
    bash -lc 'bench --site "${SITE_NAME}" install-app aishike_erp'
fi

docker compose --env-file .env exec -T backend \
  bash -lc 'bench --site "${SITE_NAME}" migrate'

docker compose --env-file .env exec -T backend \
  bash -lc 'bench --site "${SITE_NAME}" build-message-files'

"$deploy_dir/doctor.sh"

echo
echo "测试环境已就绪。"
echo "本机访问方式：ssh -N -L ${LOCAL_TUNNEL_PORT}:127.0.0.1:${HTTP_PUBLISH_PORT} company-vm"
echo "浏览器地址：http://aishike.localhost:${LOCAL_TUNNEL_PORT}"
echo "用户名：Administrator"
echo "管理员密码保存在服务器 deploy/secrets/admin_password.txt，仅在需要登录时读取。"
