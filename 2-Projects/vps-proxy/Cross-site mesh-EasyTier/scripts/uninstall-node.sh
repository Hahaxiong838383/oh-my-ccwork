#!/usr/bin/env bash
# 卸载单个节点 —— 先想好怎么回来，再动手
#
#   ./scripts/uninstall-node.sh studio
#
# 做什么：停服务 → 注销 systemd/launchd → 删配置与二进制 → 验证 TUN 与路由已消失
# 不做什么：不碰系统网络设置、不碰代理配置、不动任何非 EasyTier 的东西

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

NODE="${1:?用法: uninstall-node.sh <节点名>}"
VIP="$(node_field "$NODE" 3)"
PLAT="$(node_field "$NODE" 4)"

load_secrets
export SSHPASS="${VPS_ROOT_PASS:-}"

remote() {
  local alias sudo_kind; alias="$(node_field "$NODE" 2)"; sudo_kind="$(node_field "$NODE" 5)"
  case "$sudo_kind" in
    root)      vps_ssh "$@" ;;
    nopasswd)  ssh -o BatchMode=yes -o ConnectTimeout=25 "$alias" "sudo bash -c $(printf '%q' "$*")" ;;
    secret:*)  local v="${sudo_kind#secret:}"
               ssh -o BatchMode=yes -o ConnectTimeout=25 "$alias" \
                 "echo $(printf '%q' "${!v}") | sudo -S -p '' bash -c $(printf '%q' "$*")" ;;
    literal:*) local pw="${sudo_kind#literal:}"
               ssh -o BatchMode=yes -o ConnectTimeout=25 "$alias" \
                 "echo $(printf '%q' "$pw") | sudo -S -p '' bash -c $(printf '%q' "$*")" ;;
    ask)       [[ -n "${SUDO_PASS:-}" ]] || die "需要 SUDO_PASS=xxx"
               if [[ "$alias" == "__LOCAL__" ]]; then echo "$SUDO_PASS" | sudo -S -p '' bash -c "$*"
               else ssh -o BatchMode=yes -o ConnectTimeout=25 "$alias" \
                 "echo $(printf '%q' "$SUDO_PASS") | sudo -S -p '' bash -c $(printf '%q' "$*")"; fi ;;
  esac
}

warn "即将从 $NODE 卸载 EasyTier（虚拟 IP $VIP）"

if [[ "$PLAT" == linux-* ]]; then
  remote "systemctl disable --now easytier-mesh 2>/dev/null || true
          systemctl disable --now easytier-relay 2>/dev/null || true
          rm -f /etc/systemd/system/easytier-mesh.service /etc/systemd/system/easytier-relay.service
          systemctl daemon-reload"
else
  remote "launchctl bootout system/cn.easytier.mesh 2>/dev/null || true
          for i in 1 2 3 4 5 6 7 8 9 10; do
            launchctl print system/cn.easytier.mesh >/dev/null 2>&1 || break; sleep 1
          done
          rm -f /Library/LaunchDaemons/cn.easytier.mesh.plist"
fi

remote "rm -rf /etc/easytier /var/log/easytier
        rm -f /usr/local/bin/easytier-core /usr/local/bin/easytier-cli
        echo REMOVED"

# 验证：进程没了、虚拟 IP 没了、二进制没了 —— 三项都断言，不靠「应该」
log "$NODE 卸载后复验…"
remote "
  pgrep -f easytier-core >/dev/null && { echo 'PROC_STILL_RUNNING'; exit 1; } || echo 'PROC_GONE'
  (ip -4 addr 2>/dev/null || ifconfig 2>/dev/null) | grep -q '$VIP' && { echo 'VIP_STILL_PRESENT'; exit 1; } || echo 'VIP_GONE'
  [ -x /usr/local/bin/easytier-core ] && { echo 'BIN_STILL_PRESENT'; exit 1; } || echo 'BIN_GONE'
" || die "$NODE 卸载不干净，请人工检查"

ok "$NODE 已完全卸载，无残留"
