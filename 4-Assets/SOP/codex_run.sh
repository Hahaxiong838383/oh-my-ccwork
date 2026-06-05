#!/usr/bin/env bash
# codex exec 卡死(hang)容错 wrapper —— team 模式 codex 调用默认保护层
#
# 为什么需要它：codex exec 无内置 stream-idle timeout(codex exec --help 无 timeout flag,
#   config 的 startup_timeout_sec 只管 MCP 启动)。上游流式响应中途阻塞时,codex 进程
#   永久 read 等待:不退出/不报错/不自我超时。grok_run.sh 那种 "等 exit code" 的检测
#   对此无效(进程永不 exit)。本 wrapper 用 watchdog 监控 stdout 字节增长来判 hang。
#   根因诊断见 RECENT_EVENTS 2026-06-05 + memory feedback_codex_exec_hang_no_stream_timeout.md
#
# 用法:
#   codex_run.sh <prompt_file> <out_file> [model] [effort] [workdir]
# 退出码:
#   0 = 成功(out 有 'tokens used' 完成标志)
#   2 = hang/失败重试耗尽 → 调用方应降级到 grok/gemini
#   1 = 参数错误
#
# 可注入测试(自验用): 设 CODEX_CMD 环境变量覆盖真 codex 命令,IDLE_LIMIT/HARD_LIMIT 调短

set -uo pipefail

PROMPT_FILE="${1:?用法: codex_run.sh <prompt_file> <out_file> [model] [effort] [workdir]}"
OUT_FILE="${2:?缺 out_file}"
MODEL="${3:-gpt-5.4}"
EFFORT="${4:-high}"
WORKDIR="${5:-$PWD}"

# ── 可调参数(测试时用环境变量覆盖) ──
CHECK_INTERVAL="${CHECK_INTERVAL:-30}"   # watchdog 每隔几秒查一次字节
IDLE_LIMIT="${IDLE_LIMIT:-180}"          # 无字节增长多久判 hang(秒)。成功任务 45s 完成 2.2MB,3 分钟零增长=异常
HARD_LIMIT="${HARD_LIMIT:-900}"          # 单次调用硬上限(秒),兜底防极端
MAX_RETRY="${MAX_RETRY:-2}"              # hang/失败后重试次数
DONE_MARKER="${DONE_MARKER:-tokens used}" # codex 自身完成标志(成功日志必有,卡死必无)

if [ ! -f "$PROMPT_FILE" ]; then echo "CODEX_FAIL: prompt file 不存在 $PROMPT_FILE" >&2; exit 1; fi

# proxy 必在场(codex 走 ChatGPT 境外)
export HTTPS_PROXY="${HTTPS_PROXY:-http://127.0.0.1:10808}"
export HTTP_PROXY="${HTTP_PROXY:-http://127.0.0.1:10808}"
export NO_PROXY="${NO_PROXY:-localhost,127.0.0.1,::1,.local}"

# 杀进程+所有子孙(防 codex tokio worker / 测试场景 bash -c 孙进程残留)
# macOS 无 setsid,用递归 pkill -P 杀子树
_kill_tree() {
  local root_pid="$1"
  # 先 SIGTERM 整树(parent→child 顺序)
  local children
  children=$(pgrep -P "$root_pid" 2>/dev/null)
  for c in $children; do _kill_tree "$c"; done
  kill -TERM "$root_pid" 2>/dev/null
}
_kill_tree_force() {
  local root_pid="$1"
  local children
  children=$(pgrep -P "$root_pid" 2>/dev/null)
  for c in $children; do _kill_tree_force "$c"; done
  kill -KILL "$root_pid" 2>/dev/null
}

run_once() {  # 单次调用 + watchdog。成功 return 0 / hang return 2 / 正常失败 return 3
  local attempt="$1"
  : > "$OUT_FILE"  # 清空上次输出

  # 启动 codex(后台),记录 PID。CODEX_CMD 可注入(测试)
  if [ -n "${CODEX_CMD:-}" ]; then
    bash -c "$CODEX_CMD" < "$PROMPT_FILE" > "$OUT_FILE" 2>&1 &
  else
    codex exec -C "$WORKDIR" --full-auto \
      -c model="$MODEL" -c model_reasoning_effort="$EFFORT" \
      - < "$PROMPT_FILE" > "$OUT_FILE" 2>&1 &
  fi
  local pid=$!

  local last_size=0 stale=0 elapsed=0
  while kill -0 "$pid" 2>/dev/null; do
    sleep "$CHECK_INTERVAL"
    elapsed=$((elapsed + CHECK_INTERVAL))
    local cur_size
    cur_size=$(wc -c < "$OUT_FILE" 2>/dev/null | tr -d ' ')
    cur_size=${cur_size:-0}
    if [ "$cur_size" -gt "$last_size" ]; then
      last_size="$cur_size"; stale=0
    else
      stale=$((stale + CHECK_INTERVAL))
    fi
    # 判 hang: 进程活着但 stdout 停滞
    if [ "$stale" -ge "$IDLE_LIMIT" ]; then
      echo "CODEX_HANG: attempt=$attempt, ${IDLE_LIMIT}s 无字节增长(停在 ${last_size}B), 强制 kill pid=$pid" >&2
      _kill_tree "$pid"; sleep 2; _kill_tree_force "$pid"
      wait "$pid" 2>/dev/null
      return 2
    fi
    if [ "$elapsed" -ge "$HARD_LIMIT" ]; then
      echo "CODEX_HARDTIMEOUT: attempt=$attempt, 超 ${HARD_LIMIT}s 硬上限, kill pid=$pid" >&2
      _kill_tree "$pid"; sleep 2; _kill_tree_force "$pid"
      wait "$pid" 2>/dev/null
      return 2
    fi
  done
  wait "$pid" 2>/dev/null
  local rc=$?

  # 进程已退出: 判是否真完成(有 DONE_MARKER 且 stdout 非空)
  if [ -s "$OUT_FILE" ] && grep -q "$DONE_MARKER" "$OUT_FILE" 2>/dev/null; then
    echo "CODEX_OK: attempt=$attempt, $(wc -c <"$OUT_FILE" | tr -d ' ')B" >&2
    return 0
  fi
  echo "CODEX_FAIL_EXIT: attempt=$attempt, exit=$rc, 无完成标志'$DONE_MARKER'(可能正常失败/限流/早退)" >&2
  return 3
}

# ── 主重试循环 ──
for attempt in $(seq 1 $((MAX_RETRY + 1))); do
  run_once "$attempt"
  case $? in
    0) exit 0 ;;                                   # 成功
    2) echo "codex 第 $attempt 次 hang,已 kill,重试…" >&2 ;;   # hang → 重试
    3) echo "codex 第 $attempt 次正常失败,重试…" >&2 ;;        # 失败 → 重试
  esac
done

echo "CODEX_DEGRADE: $((MAX_RETRY + 1)) 次全失败/hang,调用方请降级到 grok/gemini" >&2
exit 2
