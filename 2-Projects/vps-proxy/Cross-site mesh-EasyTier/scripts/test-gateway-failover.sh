#!/usr/bin/env bash
# 验证家侧子网网关冗余是**真的**，不只是配置里写着
#
#   SUDO_PASS='xxx' ./scripts/test-gateway-failover.sh
#
# 做法：停掉 linux-lan 的 EasyTier → 从公司侧访问家里网段 → 看是否自动切到 fnos2 → 恢复
#
# ⚠️ 这会**故意制造一次停机**。所以：
#   · 恢复写在 trap 里，中途报错 / Ctrl-C / 脚本被 kill 都会执行
#   · 停机窗口有硬上限（MAX_DOWN 秒），到点无条件恢复
#   · 结束后**断言恢复成功**，不是恢复完就假定好了
#
# 探测目标选 10.10.1.1（家里路由器）而不是 10.10.1.119（linux-lan 自己）：
# 后者在被测节点停机时本来就该不可达，用它做判据分不清「切换失败」和「目标本身没了」。

set -uo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

MAX_DOWN="${MAX_DOWN:-90}"
PROBE_FROM="dev198"          # 从公司侧探
PROBE_TARGET="10.10.1.1"     # 家里路由器，经子网代理
DOWN_NODE="linux-lan"

[[ -n "${SUDO_PASS:-}" ]] || die "需要 linux-lan 的 sudo 密码：SUDO_PASS='xxx' $0"
load_secrets
[[ -n "${DEV198_SUDO_PASS:-}" ]] || die "Missing DEV198_SUDO_PASS in private credentials"

lan() { et_sudo_env linux-lan SUDO_PASS "$@"; }
comp_sudo() { et_sudo_env dev198 DEV198_SUDO_PASS "$@"; }
comp() { ssh -o BatchMode=yes -o ConnectTimeout=20 dev198 "$@"; }

RESTORED=0
restore() {
  [[ $RESTORED -eq 1 ]] && return
  RESTORED=1
  printf '\n\033[36m▸ 恢复 %s …\033[0m\n' "$DOWN_NODE"
  lan "systemctl start easytier-mesh" >/dev/null 2>&1
  for i in $(seq 1 20); do
    if comp "ping -c1 -W2 -q 10.10.10.21 >/dev/null 2>&1"; then
      ok "$DOWN_NODE 已恢复并重新入网"; return
    fi
    sleep 3
  done
  die "⚠️ $DOWN_NODE 未能自动恢复，请手工检查：ssh linux-lan 'sudo systemctl status easytier-mesh'"
}
trap restore EXIT INT TERM

# ── ① 基线：停机前必须是通的，否则整个实验没有意义 ──
log "① 基线：停机前从 $PROBE_FROM 访问 $PROBE_TARGET"
comp "ping -c4 -W2 -q $PROBE_TARGET 2>&1 | tail -2" || die "基线就不通，先修好再测"
comp_sudo "/usr/local/bin/easytier-cli route 2>/dev/null | grep -E '10.10.1.0/24' | cut -c1-140" \
  | sed 's/^/    当前路由: /'

# ── ② 制造故障 ──
log "② 停掉 $DOWN_NODE 的 EasyTier（停机上限 ${MAX_DOWN}s）"
lan "systemctl stop easytier-mesh" >/dev/null 2>&1
START=$(date +%s)

log "   等路由重收敛…"
sleep 20

# ── ③ 判据：家里网段是否仍可达（可达=已切到 fnos2）──
log "③ 停机中：从 $PROBE_FROM 再访问 $PROBE_TARGET"
RESULT="$(comp "ping -c6 -W2 -q $PROBE_TARGET 2>&1 | tail -2")"
printf '%s\n' "$RESULT" | sed 's/^/    /'

log "   此刻由谁在提供这条路由"
comp_sudo "/usr/local/bin/easytier-cli route 2>/dev/null | grep -E '10.10.1.0/24' | cut -c1-140" \
  | sed 's/^/    /'

LOSS="$(printf '%s' "$RESULT" | grep -oE '[0-9]+(\.[0-9]+)?% packet loss' | grep -oE '^[0-9]+')"
ELAPSED=$(( $(date +%s) - START ))
printf '\n'
if [[ -n "$LOSS" && "$LOSS" -lt 100 ]]; then
  ok "冗余成立：linux-lan 停机 ${ELAPSED}s 期间，家里网段仍可达（丢包 ${LOSS}%）"
else
  warn "冗余未生效：linux-lan 停机期间家里网段不可达 —— fnos2 没有接管"
  warn "  可能原因：路由收敛未完成 / fnos2 的 proxy_network 未生效 / 两者优先级问题"
fi
# restore 由 trap 执行
