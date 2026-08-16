#!/usr/bin/env bash
# 单机自检 —— 装在某个节点上跑 cron，只看**本机自己的** peer 表，不需要 SSH 到别处
#
# 为什么不直接把 mesh-status.sh 挂 cron：
#   mesh-status.sh 要逐台 SSH 去取各节点视角，那需要在被监控的机器上放一圈凭据。
#   监控脚本不该为了看一眼就把凭据摊开到每台机器上 —— 本机自检拿到的信息足够告警。
#
# 判据（任一不满足即告警）：
#   1. easytier 进程活着
#   2. 期望的 peer 都在（少一个就是有节点掉线）
#   3. 关键链路是 p2p 而不是 relay（退化成中继 = 延迟从 ~10ms 变 ~96ms）
#
# ⚠ 不检查 loss：到中继虚拟 IP 的丢包读数已知不可信（详见 docs/02 §二），
#   拿它做判据会天天误报。

set -uo pipefail

CLI=/usr/local/bin/easytier-cli
LOG="${ET_WATCH_LOG:-$HOME/.easytier-watch.log}"

# 期望看到的 peer（hostname），以及其中哪些必须是 p2p 直连
EXPECT_PEERS="${ET_EXPECT_PEERS:-hk-relay mini studio dev198 air}"
MUST_P2P="${ET_MUST_P2P:-dev198 mini}"     # 家侧关心的是到公司的直连

ts() { date '+%Y-%m-%d %H:%M:%S'; }
say() { printf '%s  %s\n' "$(ts)" "$*" >> "$LOG"; }

PROBLEMS=()

# 1. 进程
if ! pgrep -x easytier-core >/dev/null 2>&1; then
  PROBLEMS+=("easytier-core 进程不在")
  say "CRIT 进程不在"
  printf '%s\n' "${PROBLEMS[@]}"; exit 1
fi

OUT="$("$CLI" peer 2>/dev/null)"
if [[ -z "$OUT" ]]; then
  PROBLEMS+=("easytier-cli 取不到 peer 表（RPC 不通？）")
  say "CRIT peer 表为空"
  printf '%s\n' "${PROBLEMS[@]}"; exit 1
fi

# 2. 期望的 peer 是否都在
for h in $EXPECT_PEERS; do
  grep -q "[[:space:]]$h[[:space:]]" <<<"$OUT" || PROBLEMS+=("看不到 peer: $h")
done

# 3. 关键链路是否退化成中继
for h in $MUST_P2P; do
  line="$(grep "[[:space:]]$h[[:space:]]" <<<"$OUT" | head -1)"
  [[ -z "$line" ]] && continue
  cost="$(awk -F'|' '{gsub(/ /,"",$4); print $4}' <<<"$line")"
  if [[ "$cost" == relay* ]]; then
    lat="$(awk -F'|' '{gsub(/ /,"",$5); print $5}' <<<"$line")"
    PROBLEMS+=("$h 退化成 $cost（${lat}ms）—— 直连没打通，可能是 NAT 类型变了")
  fi
done

if [[ ${#PROBLEMS[@]} -eq 0 ]]; then
  say "OK  $(grep -cE '^\| 10\.' <<<"$OUT") 个节点在网，关键链路均为 p2p"
  exit 0
else
  for p in "${PROBLEMS[@]}"; do say "WARN $p"; done
  printf '%s\n' "${PROBLEMS[@]}"
  exit 1
fi
