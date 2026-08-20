#!/usr/bin/env bash
# 单机自检 —— 装在某个节点上跑 cron，只看**本机自己的** peer 表，不需要 SSH 到别处
#
# 为什么不直接把 mesh-status.sh 挂 cron：
#   mesh-status.sh 要逐台 SSH 去取各节点视角，那需要在被监控的机器上放一圈凭据。
#   监控脚本不该为了看一眼就把凭据摊开到每台机器上 —— 本机自检拿到的信息足够告警。
#
# 判据（任一不满足即告警）：
#   0. **到中继的真实连通性**（2026-08-20 加，见下方「僵死态」）
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
# 🔴 僵死态（2026-08-20 实战踩到，是本脚本存在的最大盲区）：
#   easytier 会进入一个**所有自述信号全绿、但实际已不在网上**的状态 ——
#   进程 active、网卡带着 IP、connector 报 Connected、peer 表满员，
#   但表是**冻结的**（隔 25 分钟两次取样，延迟数字一模一样到小数点后两位），
#   全网其它节点都看不见它，它自己日志里一条都不记。`Restart=always` 完全无效
#   （进程根本没崩）。⇒ **只读 peer 表判不出来，必须打一次真实流量。**
#   ⚠ 判据**不能用 ICMP**：中继虚拟 IP 的丢包是已知假象，2026-08-20 实测同一分钟内
#   五轮分别是 37.5%/62.5%/25%/50%/62.5%，且很可能是突发式（连续几秒黑）而非独立丢包 ——
#   「连打 N 个包全丢」的独立概率估算在突发丢包下根本不成立，会变成误报制造机。
#   改用 **TCP connect 到中继的 22 端口**：SYN 自带重传，天生抗丢包。同一时刻五轮 5/5 全通
#   （61~1122ms，慢的那两次正是重传在起作用）。判据要选**不受已知假象污染**的那个通道。
#
# 出口：结论推送到 AI Ops Cockpit 的 Uptime Kuma（push 型监控），
#   由已有的「飞书运维告警」通道发出。三类故障全覆盖：
#     成功            -> push status=up
#     判据失败        -> push status=down + 具体原因（立即告警且带原因）
#     脚本/cron/本机死 -> 什么都没推 -> Kuma 心跳超时兜底（"不推"本身就是信号）
#   push URL 是凭据，存在 ~/.easytier-watch.env（600），绝不进 git / 日志 / 回显。

set -uo pipefail

CLI=/usr/local/bin/easytier-cli
LOG="${ET_WATCH_LOG:-$HOME/.easytier-watch.log}"
STATE="${ET_WATCH_STATE:-$HOME/.easytier-watch.state}"

# shellcheck disable=SC1091
[[ -r "$HOME/.easytier-watch.env" ]] && . "$HOME/.easytier-watch.env"

EXPECT_PEERS="${ET_EXPECT_PEERS:-hk-relay mini studio dev198 fnos2 home-studio}"
MUST_P2P="${ET_MUST_P2P:-dev198 mini}"     # 家侧关心的是到公司的直连
RELAY_IP="${ET_RELAY_IP:-10.10.10.1}"
UNIT="${ET_UNIT:-easytier-mesh.service}"

# 自愈参数：连续 N 次判定「本机失联」才重启，且两次重启至少间隔 COOLDOWN 秒
# 退化告警：P2P 掉成 relay 是**性能降级不是中断**（流量照走，只是延迟 10ms→50ms+）。
# 实测 2026-08-16~20 四天触发 26 次、每天 6~7 次、**全部自行恢复**。
# 拿它发 DOWN 级告警＝每天骚扰 6 次，几天后告警就没人看了 —— 那才是真正的失效。
# 故：只有**连续** N 次仍退化才升级为告警，否则只记日志。
DEGRADE_THRESHOLD="${ET_DEGRADE_THRESHOLD:-6}"    # 6 次 × 10 分钟 = 持续 1 小时才叫

SELFHEAL="${ET_SELFHEAL:-1}"
FAIL_THRESHOLD="${ET_FAIL_THRESHOLD:-3}"
RESTART_COOLDOWN="${ET_RESTART_COOLDOWN:-3600}"

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

# 连续失败计数：只统计「本机失联」这一类，别的节点掉线不该触发本机重启
read_fails()  { [[ -r "$STATE" ]] && cut -d' ' -f1 "$STATE" 2>/dev/null || echo 0; }
read_last()   { [[ -r "$STATE" ]] && cut -d' ' -f2 "$STATE" 2>/dev/null || echo 0; }
read_degr()   { local v; v=$([[ -r "$STATE" ]] && cut -d' ' -f3 "$STATE" 2>/dev/null); echo "${v:-0}"; }
write_state() { printf '%s %s %s\n' "$1" "$2" "${3:-0}" > "$STATE"; }

PROBLEMS=()
SOFT_PROBLEMS=()   # 性能降级类，连续超阈值才升级成告警
SELF_LOST=0     # 只有这个为 1 才考虑自愈

# 0. 配置自洽：MUST_P2P 必须是 EXPECT_PEERS 的子集，否则某台掉线会静默
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

# 2. 真实连通性（僵死态唯一测得出来的判据，见文件头）
relay_reachable() {   # TCP connect，两次机会；不用 ICMP（见文件头）
  local i
  for i in 1 2; do
    timeout 6 bash -c "exec 3<>/dev/tcp/$RELAY_IP/22" 2>/dev/null && return 0
    sleep 2
  done
  return 1
}
if ! relay_reachable; then
  PROBLEMS+=("TCP 连不上中继 $RELAY_IP:22（两次重试）—— 本机已离网，peer 表可能仍是满的，别信它")
  SELF_LOST=1
fi

OUT="$("$CLI" peer 2>/dev/null)"
if [[ -z "$OUT" ]]; then
  PROBLEMS+=("easytier-cli 取不到 peer 表（RPC 不通？）")
  SELF_LOST=1
else
  # 3. 期望的 peer 是否都在
  for h in $EXPECT_PEERS; do
    grep -q "[[:space:]]$h[[:space:]]" <<<"$OUT" || PROBLEMS+=("看不到 peer: $h")
  done
  # 4. 关键链路是否退化成中继
  for h in $MUST_P2P; do
    line="$(grep "[[:space:]]$h[[:space:]]" <<<"$OUT" | head -1)"
    [[ -z "$line" ]] && continue          # 缺席已由上一步覆盖（第 0 步保证是子集）
    cost="$(awk -F'|' '{gsub(/ /,"",$4); print $4}' <<<"$line")"
    if [[ "$cost" == relay* ]]; then
      lat="$(awk -F'|' '{gsub(/ /,"",$5); print $5}' <<<"$line")"
      SOFT_PROBLEMS+=("$h 退化成 $cost（${lat}ms）")
    fi
  done
fi

# ── 自愈：只对「本机失联」生效 ──────────────────────────────────────
# 为什么限定：别的节点掉线，重启本机毫无用处，只会变成无限重启。
# 为什么要 N 次：单次网络抖动不该触发重启。
# 为什么要冷却：重启修不好的故障（比如中继真挂了）不能变成重启风暴。
HEALED=""
NOW=$(date +%s)
if (( SELF_LOST )); then
  FAILS=$(( $(read_fails) + 1 ))
  LAST=$(read_last)
  write_state "$FAILS" "$LAST"
  if [[ "$SELFHEAL" == "1" ]] && (( FAILS >= FAIL_THRESHOLD )) && (( NOW - LAST >= RESTART_COOLDOWN )); then
    say "HEAL 连续 $FAILS 次判定离网，尝试重启 $UNIT"
    if sudo -n systemctl restart "$UNIT" 2>>"$LOG"; then
      write_state 0 "$NOW"
      HEALED="；已自动重启 $UNIT（连续 $FAILS 次离网后触发）"
      say "HEAL 重启已执行"
      sleep 25
      if relay_reachable; then
        HEALED="$HEALED，重启后已恢复连通"
        say "HEAL 重启后连通性恢复"
      else
        HEALED="$HEALED，但重启后仍不通 —— 需要人工介入"
        say "HEAL 重启后仍不通"
      fi
    else
      HEALED="；自动重启失败（sudo 无权限？）需人工介入"
      say "HEAL 重启失败：sudo -n 被拒或 unit 名不对"
    fi
  fi
else
  write_state 0 "$(read_last)"
fi

# ── 退化升级判定：连续 DEGRADE_THRESHOLD 次仍退化才进告警 ──
DEGR=$(read_degr)
if [[ ${#SOFT_PROBLEMS[@]} -gt 0 ]]; then
  DEGR=$(( DEGR + 1 ))
  SOFT_MSG="$(IFS='; '; printf '%s' "${SOFT_PROBLEMS[*]}")"
  if (( DEGR >= DEGRADE_THRESHOLD )); then
    PROBLEMS+=("$SOFT_MSG —— 已持续 $DEGR 次（约 $((DEGR*10)) 分钟）未自行恢复")
  else
    say "INFO $SOFT_MSG（第 $DEGR 次，未达 $DEGRADE_THRESHOLD 次阈值，暂不告警）"
  fi
else
  DEGR=0
fi
write_state "$(read_fails)" "$(read_last)" "$DEGR"

if [[ ${#PROBLEMS[@]} -eq 0 ]]; then
  N="$(grep -cE '^\| 10\.' <<<"$OUT")"
  say "OK  $N 个节点在网，关键链路均为 p2p"
  push up "$N 个节点在网，关键链路均为 p2p"
  exit 0
else
  for p in "${PROBLEMS[@]}"; do say "WARN $p"; done
  MSG="$(IFS='; '; printf '%s' "${PROBLEMS[*]}")$HEALED"
  push down "$MSG"
  printf '%s\n' "${PROBLEMS[@]}"
  exit 1
fi
