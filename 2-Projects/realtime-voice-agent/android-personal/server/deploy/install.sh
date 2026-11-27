#!/usr/bin/env bash
# 从本目录把 night-ota 部署到飞牛2（幂等）。
#
#   HOST=hahaxiong83@192.168.1.115 bash deploy/install.sh
#   HOST=hahaxiong83@10.10.10.22     bash deploy/install.sh     # 异地走 EasyTier
#
# 只做三件事：同步代码、重建容器、验收 healthz。不动允许表、不动 Lucky、
# 不动 APK 发布目录里的任何文件。
set -euo pipefail

HOST="${HOST:-hahaxiong83@192.168.1.115}"
BASE_DIR=/vol1/1000/docker/personal-night-ota
PUBLISH_DIR=/vol1/1000/mobile/night
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> 目录"
ssh "$HOST" "mkdir -p $BASE_DIR/app $BASE_DIR/bridge $BASE_DIR/data $BASE_DIR/private $PUBLISH_DIR && chmod 700 $BASE_DIR/private"

echo "==> 代码"
rsync -a --exclude '__pycache__' \
  "$SRC_DIR/device_link.py" "$SRC_DIR/night_server.py" "$SRC_DIR/cli.py" "$SRC_DIR/allowlist_admin.py" \
  "$SRC_DIR/sql/" "$SRC_DIR/tools/" \
  "$HOST:$BASE_DIR/app/"
scp -q "$SRC_DIR/deploy/compose.yaml" "$HOST:$BASE_DIR/compose.yaml"

echo "==> 容器"
ssh "$HOST" "cd $BASE_DIR && sudo docker compose up -d --force-recreate"

echo "==> 验收"
sleep 5
ssh "$HOST" 'curl -fsS --noproxy "*" http://127.0.0.1:18786/healthz; echo'
ssh "$HOST" 'sudo docker ps --filter name=night-ota --format "{{.Names}} {{.Status}} {{.Ports}}"'
echo "完成。公网验收：curl https://pa.hahaxiong.cc:8666/mobile/night/healthz"
