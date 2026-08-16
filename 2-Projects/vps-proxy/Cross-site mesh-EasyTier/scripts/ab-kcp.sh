#!/usr/bin/env bash
# enable_kcp_proxy 的 A/B —— 在同一条链路上对撞开/关，测完自动撤回
#
#   SUDO_PASS='xxx' ./scripts/ab-kcp.sh
#
# 为什么要做这个 A/B：
#   家→公司实测单流 0.55 MB/s，正好等于 Mathis 公式在 3.3% 丢包 + 18ms RTT 下的
#   理论上限（≈0.49 MB/s）。也就是说瓶颈是**丢包**，不是带宽。
#   发送端 Air 是 macOS，没有 BBR 可换，KCP 的 ARQ 是唯一能在应用层抢回窗口的手段。
#   但 KCP 会引入冗余流量和 CPU 开销，**收益必须实测，不能凭直觉打开**。
#
# ⚠️ 会改 Air 的配置并重启 EasyTier。撤回写在 trap 里，报错/Ctrl-C 都会执行。
#
# 测量通道用 nc（纯 TCP），不用 dd|ssh —— 后者自身上限约 2.8 MB/s，会盖住真实差异。

set -uo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

PEER_NODE="dev198"          # 对端（公司侧，我有免密 sudo）
PEER_IP="10.10.10.13"
SIZE_MB="${SIZE_MB:-40}"
PARALLEL="${PARALLEL:-6}"

[[ -n "${SUDO_PASS:-}" ]] || die "需要 Air 的 sudo 密码：SUDO_PASS='xxx' $0"
load_secrets

air()  { echo "$SUDO_PASS" | sudo -S -p '' bash -c "$*"; }
peer() { ssh -o BatchMode=yes -o ConnectTimeout=20 dev198 \
           "echo 1234 | sudo -S -p '' bash -c $(printf '%q' "$*")"; }

CONF=/etc/easytier/node.toml
BAK=/etc/easytier/node.toml.abkcp

restore() {
  printf '\n\033[36m▸ 撤回 Air 的 KCP 改动…\033[0m\n'
  air "[ -f $BAK ] && install -m 600 $BAK $CONF && rm -f $BAK" 2>/dev/null
  air "launchctl kickstart -k system/cn.easytier.mesh" >/dev/null 2>&1
  for i in $(seq 1 20); do
    ping -c1 -W2 -q "$PEER_IP" >/dev/null 2>&1 && { ok "已撤回，链路恢复"; return; }
    sleep 3
  done
  warn "⚠️ 撤回后链路未在 60s 内恢复，请查 sudo launchctl print system/cn.easytier.mesh"
}
trap restore EXIT INT TERM

# 纯 TCP 吞吐测量（单流 + 并发），并在耗时过短时判为无效
measure() {  # measure <标签>
  local label="$1" ms rate
  # 单流
  # ⚠ 不能用 pkill -f 'nc -l -p 5240'：这条命令经 ssh 执行时，**它自己的命令行里就含这个
  #   字符串**，pkill 会匹配到执行它的那个 shell 并把自己杀掉，后面的 nohup 根本不执行。
  #   （2026-08-16 我在别处刚记下这个坑，转头在这个脚本里又犯了一次。）
  #   改用 pgrep -x nc（按进程名精确匹配，我的命令行不叫 nc），逐个核对端口后再 kill。
  peer "for q in \$(pgrep -x nc); do ss -tlnp 2>/dev/null | grep -q \"pid=\$q,\" && kill \$q; done; (setsid nc -l -p 5240 >/dev/null 2>&1 &)" >/dev/null 2>&1
  # 必须断言监听真的起来了：连不上时隧道内多半是**静默丢包而非 RST**，
  # nc -w 会白等满超时，测出一堆无效读数还看不出原因
  local ready=0
  for k in 1 2 3 4 5 6 7 8; do
    if peer "ss -tln 2>/dev/null | grep -q ':5240 '" >/dev/null 2>&1; then ready=1; break; fi
    sleep 1
  done
  [[ $ready -eq 1 ]] || { echo "    单流: ❌ 对端监听未就绪，跳过（不做无效测量）"; return; }
  local S=$(date +%s%N)
  dd if=/dev/zero bs=1M count="$SIZE_MB" 2>/dev/null | nc -w 45 "$PEER_IP" 5240
  local E=$(date +%s%N); ms=$(( (E-S)/1000000 ))
  if [[ $ms -lt 3000 ]]; then echo "    单流: ❌ 耗时 ${ms}ms 过短，判为连接失败，读数无效"
  else echo "    单流:   $(echo "scale=2; $SIZE_MB*1000/$ms" | bc) MB/s"; fi

  # 并发
  local ports=() p
  for i in $(seq 1 "$PARALLEL"); do p=$((5250+i)); ports+=("$p")
    peer "(setsid nc -l -p $p >/dev/null 2>&1 &)" >/dev/null 2>&1; done
  sleep 2
  local up; up=$(peer "ss -tln 2>/dev/null | grep -cE ':(525[1-9]|526[0-9]) '" 2>/dev/null | tr -d '[:space:]')
  [[ "${up:-0}" -ge 1 ]] || { echo "    ${PARALLEL}并发: ❌ 对端监听未就绪，跳过"; return; }
  S=$(date +%s%N)
  for p in "${ports[@]}"; do
    dd if=/dev/zero bs=1M count=$((SIZE_MB/2)) 2>/dev/null | nc -w 45 "$PEER_IP" "$p" &
  done; wait
  E=$(date +%s%N); ms=$(( (E-S)/1000000 ))
  local total=$(( SIZE_MB/2*PARALLEL ))
  if [[ $ms -lt 3000 ]]; then echo "    ${PARALLEL}并发: ❌ 读数无效"
  else echo "    ${PARALLEL}并发: $(echo "scale=2; $total*1000/$ms" | bc) MB/s"; fi

  echo "    丢包/RTT: $(ping -c 25 -i 0.2 -q "$PEER_IP" 2>&1 | grep -oE '[0-9.]+% packet loss' | head -1) / $(ping -c 10 -i 0.2 -q "$PEER_IP" 2>&1 | grep -oE 'avg[^ ]* = [0-9.]+/[0-9.]+' | grep -oE '[0-9.]+$')ms"
}

printf '\n\033[1m KCP A/B — Air → %s（%s）\033[0m\n' "$PEER_NODE" "$PEER_IP"
printf '%s\n' "──────────────────────────────────────────"

log "① 基线：KCP 关（当前生产配置）"
measure "off"

log "② 打开 enable_kcp_proxy 并重启"
air "cp $CONF $BAK && sed -i '' 's/^enable_kcp_proxy = false/enable_kcp_proxy = true/' $CONF && grep '^enable_kcp_proxy' $CONF"
air "launchctl kickstart -k system/cn.easytier.mesh" >/dev/null 2>&1
for i in $(seq 1 20); do ping -c1 -W2 -q "$PEER_IP" >/dev/null 2>&1 && break; sleep 3; done
sleep 8

log "③ KCP 开"
measure "on"

printf '\n\033[33m判读：并发流的数值更能反映真实上限；单流若从 ~0.55 提升到 >1 MB/s，说明 KCP 有效。\033[0m\n'
printf '\033[33m若两组差异 <15%%，视为无显著收益 —— 保持关闭，不为说不清的收益引入冗余流量。\033[0m\n'
# restore 由 trap 执行
