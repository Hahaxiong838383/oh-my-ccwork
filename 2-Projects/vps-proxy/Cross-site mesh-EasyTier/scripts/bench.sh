#!/usr/bin/env bash
# 链路基准测量 —— 延迟 / 丢包 / 吞吐，并支持 KCP 开关的 A/B
#
#   ./scripts/bench.sh <源节点> <目标节点>          # 例：./scripts/bench.sh dev198 hk-relay
#   ./scripts/bench.sh <源节点> <目标节点> --kcp-ab # 同上，再做一次开 KCP 的对照
#
# ⚠ 判读规则（脱离这条会得出完全错误的结论，详见 docs/02）：
#   ping 中继节点自己的虚拟 IP（10.10.10.1）会稳定丢 10–30%，而同一时刻 TCP 吞吐正常。
#   所以**丢包率不能单独作为健康判据**，必须和吞吐一起看。
#   两个客户端节点之间的 ping 才是可信的丢包读数。

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
set +e

SRC="${1:?用法: bench.sh <源节点> <目标节点> [--kcp-ab]}"
DST="${2:?用法: bench.sh <源节点> <目标节点> [--kcp-ab]}"
KCP_AB=0; [[ "${3:-}" == "--kcp-ab" ]] && KCP_AB=1

load_secrets
export SSHPASS="${VPS_ROOT_PASS:-}"

DST_IP="$(node_field "$DST" 3)"

# 在源节点上执行（复用 deploy-node.sh 的 sudo 分派逻辑的简化版）
on_src() {
  local alias sudo_kind; alias="$(node_field "$SRC" 2)"; sudo_kind="$(node_field "$SRC" 5)"
  case "$sudo_kind" in
    root)      vps_ssh "$@" ;;
    nopasswd)  ssh -o BatchMode=yes -o ConnectTimeout=25 "$alias" "$@" ;;
    secret:*)  ssh -o BatchMode=yes -o ConnectTimeout=25 "$alias" "$@" ;;
    ask)       [[ "$alias" == "__LOCAL__" ]] && bash -c "$*" \
                 || ssh -o BatchMode=yes -o ConnectTimeout=25 "$alias" "$@" ;;
  esac
}

printf '\n\033[1m 基准测量  %s → %s (%s)\033[0m\n' "$SRC" "$DST" "$DST_IP"
printf '%s\n' "──────────────────────────────────────────────────"

log "① 延迟与丢包（隧道内，100 包）"
on_src "ping -c 100 -i 0.2 -q $DST_IP 2>&1 | tail -3"

log "② 链路类型与通道（p2p 还是 relay）"
on_src "command -v easytier-cli >/dev/null && sudo -n easytier-cli peer 2>/dev/null | grep -E 'hostname|$DST' || true"

log "③ 吞吐（需目标节点已起 iperf3 -s -B $DST_IP）"
warn "   若报 connection refused，先在 $DST 上跑：  iperf3 -s -B $DST_IP -D"
on_src "iperf3 -c $DST_IP -t 15 -P 4 2>&1 | grep -E 'SUM|sender|receiver' | tail -4"

if [[ $KCP_AB -eq 1 ]]; then
  printf '\n'
  warn "④ KCP A/B —— 本步会**改配置并重启** $SRC 的 EasyTier，结束后自动还原"
  warn "   排障补丁不撤就是下一次事故的引信，所以还原是脚本的一部分，不是靠人记得"
  echo "   （尚未实现自动化：请按 docs/02 §四 的流程手工执行，改 enable_kcp_proxy 后重跑 ①③）"
fi

printf '\n\033[33m判读提醒：丢包率单独看没有意义。\033[0m\n'
printf '\033[33m  · 目标是中继(10.10.10.1) → 丢包 10–30%% 属已知假象，看吞吐即可\033[0m\n'
printf '\033[33m  · 目标是客户端节点     → 丢包读数才可信\033[0m\n\n'
