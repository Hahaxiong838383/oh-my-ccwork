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
#
# ⚠ 期望列表只放**常驻开机**的设备。air 是笔记本，合盖即掉线，放进来会变成
#   定时炸弹式误报源 —— 误报几次之后告警就没人看了，那才是真正的失效。
#
# 出口（2026-08-17 加）：结论推送到 AI Ops Cockpit 的 Uptime Kuma（push 型监控），
#   由已有的「飞书运维告警」通道发出。三类故障全覆盖：
#     成功            -> push status=up
#     判据失败        -> push status=down + 具体原因（立即告警且带原因）
#     脚本/cron/本机死 -> 什么都没推 -> Kuma 心跳超时兜底（"不推"本身就是信号）
#   push URL 是凭据，存在 ~/.easytier-watch.env（600），绝不进 git / 日志 / 回显。

set -uo pipefail

CLI=/usr/local/bin/easytier-cli
LOG="${ET_WATCH_LOG:-$HOME/.easytier-watch.log}"

# shellcheck disable=SC1091
[[ -r "$HOME/.easytier-watch.env" ]] && . "$HOME/.easytier-watch.env"

# 期望看到的 peer（hostname），以及其中哪些必须是 p2p 直连
EXPECT_PEERS="${ET_EXPECT_PEERS:-hk-relay mini studio dev198 fnos2}"
MUST_P2P="${ET_MUST_P2P:-dev198 mini}"     # 家侧关心的是到公司的直连

ts() { date '+%Y-%m-%d %H:%M:%S'; }
say() { printf '%s  %s\n' "$(ts)" "$*" >> "$LOG"; }

push() {  # $1=up|down  $2=msg
  [[ -n "${ET_KUMA_PUSH_URL:-}" ]] || return 0
  curl -fsS --max-time 15 -G -o /dev/null \
    --data-urlencode "status=$1" \
    --data-urlencode "msg=$2" \
    "$ET_KUMA_PUSH_URL" 2>/dev/null \
    || say "WARN 心跳推送失败（Kuma 不可达）—— Kuma 侧会以超时告警兜底"
}

PROBLEMS=()

# 0. 配置自洽：MUST_P2P 必须是 EXPECT_PEERS 的子集，否则某台掉线会静默
#    （原版对不在 peer 表里的 MUST_P2P 主机直接 continue，是个隐性盲区）
for h in $MUST_P2P; do
  grep -qw -- "$h" <<<"$EXPECT_PEERS" || {
    say "CRIT 配置错误: MUST_P2P 的 $h 不在 EXPECT_PEERS 里，它掉线不会被发现"
    push down "配置错误: MUST_P2P 的 $h 不在 EXPECT_PEERS 里"
    printf '配置错误: MUST_P2P 的 %s 不在 EXPECT_PEERS 里\n' "$h"; exit 2
  }
done

# 1. 进程
if ! pgrep -x easytier-core >/dev/null 2>&1; then
  say "CRIT 进程不在"
  push down "easytier-core 进程不在"
  printf 'easytier-core 进程不在\n'; exit 1
fi

OUT="$("$CLI" peer 2>/dev/null)"
if [[ -z "$OUT" ]]; then
  say "CRIT peer 表为空"
  push down "easytier-cli 取不到 peer 表（RPC 不通？）"
  printf 'easytier-cli 取不到 peer 表\n'; exit 1
fi

# 2. 期望的 peer 是否都在
for h in $EXPECT_PEERS; do
  grep -q "[[:space:]]$h[[:space:]]" <<<"$OUT" || PROBLEMS+=("看不到 peer: $h")
done

# 3. 关键链路是否退化成中继
for h in $MUST_P2P; do
  line="$(grep "[[:space:]]$h[[:space:]]" <<<"$OUT" | head -1)"
  [[ -z "$line" ]] && continue          # 缺席已由第 2 步覆盖（第 0 步保证是子集）
  cost="$(awk -F'|' '{gsub(/ /,"",$4); print $4}' <<<"$line")"
  if [[ "$cost" == relay* ]]; then
    lat="$(awk -F'|' '{gsub(/ /,"",$5); print $5}' <<<"$line")"
    PROBLEMS+=("$h 退化成 $cost（${lat}ms）—— 直连没打通，可能是 NAT 类型变了")
  fi
done

if [[ ${#PROBLEMS[@]} -eq 0 ]]; then
  N="$(grep -cE '^\| 10\.' <<<"$OUT")"
  say "OK  $N 个节点在网，关键链路均为 p2p"
  push up "$N 个节点在网，关键链路均为 p2p"
  exit 0
else
  for p in "${PROBLEMS[@]}"; do say "WARN $p"; done
  MSG="$(IFS='; '; printf '%s' "${PROBLEMS[*]}")"
  push down "$MSG"
  printf '%s\n' "${PROBLEMS[@]}"
  exit 1
fi
