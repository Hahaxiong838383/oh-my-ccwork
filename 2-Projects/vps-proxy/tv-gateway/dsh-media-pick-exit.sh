#!/bin/bash
# Measure candidate exits on the existing SOCKS sidecar while the TV is idle.
# Verify the candidate and the foreground again before changing new connections.
set -u

API=http://127.0.0.1:9090
STATE="$(dirname -- "$0")/dsh-media-state.sh"
RUNDIR=${RUNTIME_DIRECTORY:-/run}
exec 9>"$RUNDIR/dsh-media-exit.lock" || exit 1
flock -n 9 || exit 0
GOOGLE=https://dl.google.com/go/go1.23.0.linux-amd64.tar.gz
HETZNER=https://sin-speed.hetzner.com/1GB.bin
PROBE_BASE=19201
MAP=${DSH_PROBE_MAP:-/var/lib/dsh/probe-map.json}
mapfile -t EXITS < <(python3 -c 'import json,sys; print("\n".join(json.load(open(sys.argv[1]))))' "$MAP")
[ "${#EXITS[@]}" -gt 0 ] || exit 1

LCAP=12582912      # 例行体检上限 12 MiB
LWINDOW=5          # 例行体检窗口 5 s
SCAP=8388608       # 扫描单次上限 8 MiB（并行，控总量）
SWINDOW=6          # 扫描单次窗口 6 s
RCAP=26214400      # 串行复测上限 25 MiB
RWINDOW=6          # 串行复测窗口 6 s
GOOD=4.0           # 健康线 MB/s（32 Mbps）
MIN=2.5            # 底线 MB/s（20 Mbps = YouTube 4K 官方门槛）
GAIN=1.25          # 至少快 25% 才切
STAMP=$RUNDIR/dsh-pick-sweep.stamp
FULL_EVERY=21600   # 6 小时至少全量扫描一次
FAILS=$RUNDIR/dsh-pick.fails
TMP=$RUNDIR/dsh-sweep

log() { logger -t dsh-pick "$*"; }
now_exit() { curl -s --max-time 5 "$API/proxies/proxy" 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin).get("now",""))' 2>/dev/null; }
set_exit() { curl -fsS --max-time 5 -X PUT "$API/proxies/proxy" -d "{\"name\":\"$1\"}" >/dev/null 2>&1; }
port_of() {
  local i=0 e
  for e in "${EXITS[@]}"; do [ "$e" = "$1" ] && { echo $((PROBE_BASE + i)); return; }; i=$((i + 1)); done
  echo 0
}

# meas EXIT URL [CAP_BYTES] [SECS] -> 有效 MB/s（正文大小 / 整次请求时间，含建连和首字节）
meas() {
  local exit="$1" url="$2" cap="${3:-$LCAP}" win="${4:-$LWINDOW}" p out code size total
  p=$(port_of "$exit"); [ "$p" = 0 ] && { echo 0; return; }
  out=$(curl -s --max-time "$win" --max-filesize "$cap" --socks5-hostname "127.0.0.1:$p" -o /dev/null \
        -H 'Accept-Encoding: identity' --range "0-$((cap - 1))" \
        -w '%{http_code} %{size_download} %{time_total}' "$url" 2>/dev/null)
  set -- $out; code=${1:-0}; size=${2:-0}; total=${3:-0}
  case "$code" in 200|206) ;; *) echo 0; return ;; esac
  awk -v size="$size" -v total="$total" 'BEGIN {printf "%.2f\n", (total > 0 ? size / total / 1048576 : 0)}'
}

median() { printf '%s\n' "$1" "$2" "$3" | sort -n | sed -n '2p'; }

# 三轮并行排序，前两名串行复测后才有资格成为候选。
sweep() {
  local r e a b c v best="" bests=0
  mkdir -p "$TMP"
  for r in 1 2 3; do
    "$STATE" idle || return 1
    for e in "${EXITS[@]}"; do
      ( meas "$e" "$GOOGLE" "$SCAP" "$SWINDOW" > "$TMP/$r.$e" 2>/dev/null ) &
    done
    wait
  done
  declare -A SCORE
  for e in "${EXITS[@]}"; do
    a=$(cat "$TMP/1.$e" 2>/dev/null || echo 0); b=$(cat "$TMP/2.$e" 2>/dev/null || echo 0); c=$(cat "$TMP/3.$e" 2>/dev/null || echo 0)
    v=$(median "$a" "$b" "$c")
    SCORE[$e]=$v
  done
  # 串行复测前二：并行样本只用于排序，绝对值以串行 25MB/6s 为准
  local top
  top=$(for e in "${EXITS[@]}"; do echo "${SCORE[$e]} $e"; done | sort -rn | head -2 | awk '{print $2}')
  # 串行复测前二：三采取中位（稳定优先于峰值 —— hk-v6 这类「一采 15MB/s、后两采 0.1」的突发通道必须被压下去）
  for e in $top; do
    local s1 s2 s3 med
    "$STATE" idle || return 1
    s1=$(meas "$e" "$GOOGLE" "$RCAP" "$RWINDOW")
    "$STATE" idle || return 1
    s2=$(meas "$e" "$GOOGLE" "$RCAP" "$RWINDOW")
    "$STATE" idle || return 1
    s3=$(meas "$e" "$GOOGLE" "$RCAP" "$RWINDOW")
    med=$(median "$s1" "$s2" "$s3")
    log "confirm $e parallel=${SCORE[$e]} serial=$s1/$s2/$s3 -> median=$med"
    SCORE[$e]=$med
  done
  best=""; bests=0
  for e in $top; do
    if python3 -c "import sys;sys.exit(0 if float('${SCORE[$e]}')>float('$bests') else 1)" 2>/dev/null; then
      best=$e; bests=${SCORE[$e]}
    fi
  done
  "$STATE" idle || return 1
  local hz=0
  [ -n "$best" ] && hz=$(meas "$best" "$HETZNER" "$SCAP" "$SWINDOW")
  log "sweep: $(for e in "${EXITS[@]}"; do printf '%s=%s ' "$e" "${SCORE[$e]}"; done)|best=$best(${bests}MB/s) hetzner=$hz"
  echo "$best $bests"
}

"$STATE" idle || exit 0
CUR=$(now_exit)
[ -z "$CUR" ] && { log "clash api unreachable, skip"; exit 0; }

# 1) 当前出口轻量体检（低于底线时取三次中位数）
CUR_S=$(meas "$CUR" "$GOOGLE" "$LCAP" "$LWINDOW")
if python3 -c "import sys;sys.exit(0 if float('$CUR_S')<float('$MIN') else 1)" 2>/dev/null; then
  "$STATE" idle || exit 0
  C2=$(meas "$CUR" "$GOOGLE" "$LCAP" "$LWINDOW")
  "$STATE" idle || exit 0
  C3=$(meas "$CUR" "$GOOGLE" "$LCAP" "$LWINDOW")
  CUR_S=$(median "$CUR_S" "$C2" "$C3")
fi
"$STATE" idle || exit 0

NOW=$(date +%s); LAST=$(cat "$STAMP" 2>/dev/null || echo 0)
FORCE=0
[ $((NOW - LAST)) -ge "$FULL_EVERY" ] && FORCE=1
python3 -c "import sys;sys.exit(0 if float('$CUR_S')<float('$MIN') else 1)" 2>/dev/null && FORCE=1

if [ "$FORCE" = 0 ]; then
  if python3 -c "import sys;sys.exit(0 if float('$CUR_S')<float('$GOOD') else 1)" 2>/dev/null; then
    log "note: current=$CUR ${CUR_S}MB/s below good($GOOD); keep"
  else
    echo 0 > "$FAILS" 2>/dev/null
    log "ok current=$CUR ${CUR_S}MB/s"
  fi
  exit 0
fi

# 2) 全量扫描并择优
ranking=$(sweep) || exit 0
read -r BEST BESTS <<< "$ranking"
date +%s > "$STAMP"
[ -z "$BEST" ] && { log "sweep nothing, keep $CUR"; exit 0; }
[ "$BEST" = "$CUR" ] && { log "keep $CUR (${CUR_S} -> ${BESTS})"; exit 0; }

BETTER=$(python3 -c "
cur=float('$CUR_S'); best=float('$BESTS'); gain=float('$GAIN')
print('yes' if best>=max(cur*gain, float('$MIN')) else 'no')" 2>/dev/null)
if [ "$BETTER" = "yes" ]; then
  "$STATE" idle || exit 0
  verified=$(meas "$BEST" "$GOOGLE" "$LCAP" "$LWINDOW")
  if ! awk -v got="$verified" -v min="$MIN" -v current="$CUR_S" -v gain="$GAIN" 'BEGIN {exit !(got >= min && got >= current * gain)}'; then
    log "candidate $BEST retested at ${verified}MB/s, keeping $CUR"
    exit 0
  fi
  [ "$(now_exit)" = "$CUR" ] && "$STATE" idle || exit 0
  if set_exit "$BEST" && [ "$(now_exit)" = "$BEST" ]; then
    log "switch $CUR(${CUR_S}MB/s) -> $BEST(${BESTS}MB/s verified=$verified)"
  else
    log "selector change to $BEST was not confirmed"
    exit 1
  fi
else
  log "no switch: best=$BEST($BESTS) vs cur=$CUR($CUR_S) gain<$GAIN"
fi
