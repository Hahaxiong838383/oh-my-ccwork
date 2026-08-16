#!/usr/bin/env bash
# 把 EasyTier 以 Docker 方式部署到飞牛 NAS
#
#   SUDO_PASS='xxx' ./scripts/deploy-fnos-docker.sh fnos2
#
# 为什么单独一个脚本而不是并进 deploy-node.sh：
#   fnOS 上不能装原生二进制（官方升级会重置底层，且是静默失效），
#   载体从 systemd 换成了 Docker，部署流程和验收判据都不一样。
#
# 凭据处理：
#   · 文件都以**普通用户**身份写进 $HOME（不需要 sudo，stdin 干净）
#   · 只有 docker 命令走 sudo -S（该账号不在 docker 组）
#   · network_secret 经 ssh stdin 传输，不进命令行参数（ps 可见即泄露）

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

NODE="${1:-fnos2}"
NAS_HOST="${NAS_HOST:-hahaxiong83@192.168.1.115}"
REMOTE_DIR="${REMOTE_DIR:-/home/hahaxiong83/easytier}"

[[ -n "${SUDO_PASS:-}" ]] || die "需要 sudo 密码：SUDO_PASS='xxx' $0 $NODE"
load_secrets

TMPL="$PROJ_DIR/nodes/$NODE.toml"
COMPOSE="$PROJ_DIR/nodes/fnos-docker-compose.yml"
[[ -f "$TMPL" ]] || die "缺少 $TMPL"
[[ -f "$COMPOSE" ]] || die "缺少 $COMPOSE"

nas()      { ssh -o BatchMode=yes -o ConnectTimeout=25 "$NAS_HOST" "$@"; }
nas_sudo() { ssh -o BatchMode=yes -o ConnectTimeout=60 "$NAS_HOST" \
               "echo $(printf '%q' "$SUDO_PASS") | sudo -S -p '' bash -c $(printf '%q' "$*")"; }

log "① 渲染配置并上传（普通用户身份，stdin 干净）"
content="$(<"$TMPL")"
content="${content//__NETWORK_NAME__/$EASYTIER_NETWORK_NAME}"
content="${content//__NETWORK_SECRET__/$EASYTIER_NETWORK_SECRET}"

nas "mkdir -p '$REMOTE_DIR' && chmod 700 '$REMOTE_DIR'"
printf '%s\n' "$content" | nas "umask 077; cat > '$REMOTE_DIR/node.toml'"
scp -o BatchMode=yes -q "$COMPOSE" "$NAS_HOST:$REMOTE_DIR/docker-compose.yml"

# 落地即断言：空配置不会报错，EasyTier 会安静地用默认值起来
nas "
  [ -s '$REMOTE_DIR/node.toml' ] || { echo CONFIG_EMPTY; exit 1; }
  grep -q '^\[network_identity\]' '$REMOTE_DIR/node.toml' || { echo CONFIG_NO_IDENTITY; exit 1; }
  grep -q '__NETWORK_SECRET__' '$REMOTE_DIR/node.toml' && { echo CONFIG_PLACEHOLDER; exit 1; }
  ls -l '$REMOTE_DIR/node.toml'; echo CONFIG_OK" || die "配置落地失败"

log "② 拉镜像并启动容器"
# --force-recreate 不能省：node.toml 是 bind mount，改它的**内容**不会让 compose 认为
# 容器过期（compose 只比对定义），容器会继续跑启动时读进内存的旧配置。
# 2026-08-16 实测踩到：改了 hostname，配置文件确实更新了，容器却还报旧名字，
# 而当时的三项验收（容器 running / 虚拟IP / 看得见 peer）全过 —— 因为没一项检查被改的那个量。
nas_sudo "cd '$REMOTE_DIR' && docker compose pull -q && docker compose up -d --force-recreate && docker compose ps"

log "③ 验收（等容器就绪，逐项断言）"
nas_sudo "
  for i in \$(seq 1 20); do
    docker exec easytier easytier-cli peer >/dev/null 2>&1 && break
    sleep 3
  done
  echo '--- [1/4] 容器状态 ---'
  docker inspect -f '{{.State.Status}}' easytier | grep -q running && echo CONTAINER_OK || { echo CONTAINER_FAIL; exit 1; }

  echo '--- [2/4] 虚拟 IP ---'
  docker exec easytier ip -4 addr 2>/dev/null | grep -q '10.10.10.22' && echo VIP_OK || { echo VIP_FAIL; exit 1; }

  echo '--- [3/4] 配置与运行态一致（防止改了配置但容器没重载）---'
  WANT=\$(grep '^hostname' '$REMOTE_DIR/node.toml' | sed -E 's/.*= *\"(.*)\"/\\1/')
  GOT=\$(docker exec easytier easytier-cli peer 2>/dev/null | awk -F'|' '\$4 ~ /Local/ {gsub(/ /,\"\",\$3); print \$3}')
  [ -n \"\$WANT\" ] && [ \"\$WANT\" = \"\$GOT\" ] \\
    && echo \"HOSTNAME_OK (配置=\$WANT 运行=\$GOT)\" \\
    || { echo \"HOSTNAME_MISMATCH 配置=\$WANT 但容器在跑 \$GOT —— 容器没重载\"; exit 1; }

  echo '--- [4/4] 至少看见 1 个远端 peer（唯一能证明真入网的判据）---'
  docker exec easytier easytier-cli peer 2>&1
  N=\$(docker exec easytier easytier-cli peer 2>/dev/null | grep -cE '^\| 10\.10\.10\.' )
  [ \"\$N\" -ge 2 ] && echo \"PEER_OK 表内节点数=\$N\" || { echo 'PEER_FAIL 只看到自己'; exit 1; }
" || die "$NODE 验收未过 —— 不视为部署成功"

ok "$NODE 部署完成（Docker）"
