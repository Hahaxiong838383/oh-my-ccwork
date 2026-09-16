#!/usr/bin/env bash
# 公共函数库 —— 被 deploy-node.sh / mesh-status.sh / bench.sh source
# 不要直接执行。

set -euo pipefail

ET_VERSION="${ET_VERSION:-v2.6.4}"
PROJ_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS_FILE="${SECRETS_FILE:-$HOME/.mycc-secrets.env}"

# Web 控制台的配置服务器。节点加上它才会出现在控制台的设备列表里
# （控制台没有 devices 表，设备状态是 web 服务的内存态，靠这条活连接维持）。
# 地址用虚拟网 IP：22020 在供应商防火墙白名单之外，公网打不进来。
ET_CONFIG_SERVER_USER="${ET_CONFIG_SERVER_USER:-hahaxiong83}"
ET_CONFIG_SERVER="udp://10.10.10.1:22020/${ET_CONFIG_SERVER_USER}"

# ── 节点真值表 ────────────────────────────────────────────────────────────
# name | ssh别名 | 虚拟IP | 平台 | sudo方式
# sudo方式: nopasswd | secret:<VAR名> | literal:<值> | ask | windows-admin
ET_NODES=(
  "hk-relay|__VPS_DIRECT__|10.10.10.1|linux-x86_64|root"
  "mini|mini-pub|10.10.10.11|macos-aarch64|nopasswd"
  "studio|studio-pub|10.10.10.12|macos-aarch64|secret:STUDIO_SUDO_PASS"
  "nio-war-mac|nio-war-mac-wifi|10.10.10.14|macos-aarch64|ask"
  "dev198|dev198|10.10.10.13|linux-x86_64|literal:1234"
  "linux-lan|linux-lan|10.10.10.21|linux-x86_64|ask"
  "home-studio|hahaxiong83@192.168.1.133|10.10.10.23|linux-x86_64|ask"
  "maxtkf-server|Administrator@192.168.1.77|10.10.10.24|windows-x86_64|windows-admin"
  "air|__LOCAL__|10.10.10.31|macos-aarch64|ask"
  # 飞牛走 Docker 部署（fnOS 官方升级会重置底层，装原生二进制会静默失效）
  # 命名真值：115=飞牛2号(FNOS-2) / 43=飞牛1号(未接入，将来用 fnos1 + 10.10.10.23)
  "fnos2|hahaxiong83@192.168.1.115|10.10.10.22|docker-x86_64|ask"
)

node_field() {  # node_field <name> <1..5>
  local n="$1" i="$2" row
  for row in "${ET_NODES[@]}"; do
    [[ "${row%%|*}" == "$n" ]] && { echo "$row" | cut -d'|' -f"$i"; return 0; }
  done
  echo "未知节点: $n" >&2; return 1
}

load_secrets() {
  if [[ -f "$SECRETS_FILE" ]]; then
    # shellcheck disable=SC1090
    set -a; source "$SECRETS_FILE"; set +a
  elif [[ -z "${EASYTIER_NETWORK_NAME:-}" || -z "${EASYTIER_NETWORK_SECRET:-}" ]]; then
    echo "缺少 $SECRETS_FILE，且环境变量里没有 EasyTier 网络身份" >&2
    return 1
  fi
  : "${EASYTIER_NETWORK_NAME:?secrets 里缺 EASYTIER_NETWORK_NAME}"
  : "${EASYTIER_NETWORK_SECRET:?secrets 里缺 EASYTIER_NETWORK_SECRET}"
}

# ── 香港中继的 SSH 通道 ────────────────────────────────────────────────────
# 2026-08-16 起该机已开公钥登录（此前 sshd 是 PubkeyAuthentication no，只能走密码）。
# 优先密钥；密钥不可用时回落密码，避免哪天 sshd 配置被重置就全线瘫痪。
VPS_HOST="${VPS_HOST:-207.57.124.191}"

vps_ssh() {
  if ssh -o IdentitiesOnly=yes -i "$HOME/.ssh/id_ed25519" \
         -o PreferredAuthentications=publickey -o PasswordAuthentication=no \
         -o BatchMode=yes -o ConnectTimeout=10 -n "root@$VPS_HOST" true 2>/dev/null; then
    ssh -o IdentitiesOnly=yes -i "$HOME/.ssh/id_ed25519" \
        -o PreferredAuthentications=publickey -o BatchMode=yes \
        -o StrictHostKeyChecking=no -o ConnectTimeout=30 "root@$VPS_HOST" "$@"
  else
    [[ -n "${VPS_ROOT_PASS:-}" ]] || { echo "密钥登录不可用且无 VPS_ROOT_PASS" >&2; return 1; }
    if command -v sshpass >/dev/null 2>&1; then
      SSHPASS="$VPS_ROOT_PASS" sshpass -e ssh -o PreferredAuthentications=password \
          -o PubkeyAuthentication=no -o StrictHostKeyChecking=no -o ConnectTimeout=30 \
          "root@$VPS_HOST" "$@"
    else
      DISPLAY=:0 SSH_ASKPASS_REQUIRE=force SSH_ASKPASS="$PROJ_DIR/scripts/ssh-askpass-env.sh" \
        setsid -w ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no \
          -o NumberOfPasswordPrompts=1 -o StrictHostKeyChecking=no -o ConnectTimeout=30 \
          "root@$VPS_HOST" "$@" </dev/null
    fi
  fi
}

vps_scp() {  # vps_scp <本地> <远端路径>
  if ssh -o IdentitiesOnly=yes -i "$HOME/.ssh/id_ed25519" \
         -o PreferredAuthentications=publickey -o PasswordAuthentication=no \
         -o BatchMode=yes -o ConnectTimeout=10 -n "root@$VPS_HOST" true 2>/dev/null; then
    scp -o IdentitiesOnly=yes -i "$HOME/.ssh/id_ed25519" -o BatchMode=yes \
        -o StrictHostKeyChecking=no -o ConnectTimeout=30 "$1" "root@$VPS_HOST:$2" >/dev/null
  else
    if command -v sshpass >/dev/null 2>&1; then
      SSHPASS="$VPS_ROOT_PASS" sshpass -e scp -o PreferredAuthentications=password \
          -o PubkeyAuthentication=no -o StrictHostKeyChecking=no -o ConnectTimeout=30 \
          "$1" "root@$VPS_HOST:$2" >/dev/null
    else
      DISPLAY=:0 SSH_ASKPASS_REQUIRE=force SSH_ASKPASS="$PROJ_DIR/scripts/ssh-askpass-env.sh" \
        setsid -w scp -o PreferredAuthentications=password -o PubkeyAuthentication=no \
          -o NumberOfPasswordPrompts=1 -o StrictHostKeyChecking=no -o ConnectTimeout=30 \
          "$1" "root@$VPS_HOST:$2" >/dev/null </dev/null
    fi
  fi
}

log()  { printf '\033[36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
