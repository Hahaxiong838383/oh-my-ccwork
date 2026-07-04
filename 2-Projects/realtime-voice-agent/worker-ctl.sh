#!/usr/bin/env bash
# dev198 voice worker 控制台:安全重启 / 调 VAD 门控 / 状态 / 日志
#
# 背景(2026-06-29):
#  - 重启 worker 曾踩 `pkill -f "voice_agent.app livekit start"` 自杀坑——ssh 整行命令
#    本身含该 pattern 字符串,pkill 把自己父 bash 也杀了 → ssh 断、worker 没起来。
#    本脚本用 pgrep 取 PID 再 kill,且脚本进程命令行=`bash worker-ctl.sh`不含 pattern
#    → 不自杀;启动用 setsid 脱离(ssh 退出不带走 worker)。
#  - VAD 门控参数(治背景误触发,tier_a_cascade.py)env 化:
#    VAD_ACTIVATION_THRESHOLD(语音判定阈值,默认 0.6)/ VAD_MIN_SPEECH_DURATION(最短语音秒,默认 0.15)。
#
# 用法(在 dev198 ~/realtime-voice-agent 下):
#   ./worker-ctl.sh status               进程 + 当前 VAD 档 + log 尾
#   ./worker-ctl.sh restart              安全重启(等 registered 确认连上 livekit)
#   ./worker-ctl.sh set-vad 0.7 [0.15]   改 .env VAD 阈值(activation [min_speech])并重启
#   ./worker-ctl.sh reset                删 .env VAD 覆盖,回代码默认 0.6/0.15 并重启
#   ./worker-ctl.sh stop                 停 worker
#   ./worker-ctl.sh logs [N]             tail -N worker.log(默认 30)
set -uo pipefail
cd "$(dirname "$0")"
LOG=worker.log
WORKER_PAT="voice_agent.app livekit start"
FORK_PAT="livekit.agents.inference._warmup"

_pids() { pgrep -f "$WORKER_PAT" || true; }

_vad_line() {
  if grep -qE "^VAD_ACTIVATION_THRESHOLD=" .env 2>/dev/null; then
    echo -n "   VAD 档(.env 覆盖): "; grep -E "^VAD_(ACTIVATION_THRESHOLD|MIN_SPEECH_DURATION)=" .env | tr '\n' ' '; echo
  else
    echo "   VAD 档: 代码默认 activation=0.6 min_speech=0.15(.env 未覆盖)"
  fi
}

_stop() {
  local pids; pids=$(_pids)
  if [ -n "$pids" ]; then echo "停 worker PID: $pids"; kill $pids 2>/dev/null || true; fi
  pkill -f "$FORK_PAT" 2>/dev/null || true   # 清 forkserver 预热子进程
  local i
  for i in 1 2 3 4 5; do [ -z "$(_pids)" ] && break; sleep 1; done
  pids=$(_pids)
  if [ -n "$pids" ]; then echo "强杀残留: $pids"; kill -9 $pids 2>/dev/null || true; pkill -9 -f "$FORK_PAT" 2>/dev/null || true; fi
}

_start() {
  local before; before=$(wc -l < "$LOG" 2>/dev/null || echo 0)
  echo "=== restart $(date '+%F %T') ===" >> "$LOG"
  setsid bash run-worker.sh >> "$LOG" 2>&1 < /dev/null &
  echo "worker 启动中(setsid 脱离),等 registered(最多 30s)..."
  local i
  for i in $(seq 1 30); do
    if tail -n "+$before" "$LOG" | grep -q "registered worker"; then
      echo "✅ registered worker — 已连上 livekit"; _vad_line; return 0
    fi
    if tail -n "+$before" "$LOG" | grep -qiE "after 16 attempts|invalid API key|Traceback"; then
      echo "❌ 启动报错,看 log 尾:"; tail -8 "$LOG"; return 1
    fi
    sleep 1
  done
  echo "⚠️ 30s 未见 registered,看 log 尾:"; tail -10 "$LOG"; return 1
}

_status() {
  local pids; pids=$(_pids)
  if [ -n "$pids" ]; then echo "worker: ✅ 运行中 PID=$pids"; else echo "worker: ❌ 未运行"; fi
  _vad_line
  echo "--- worker.log 尾 6 行 ---"; tail -6 "$LOG" 2>/dev/null || true
}

_set_vad() {
  local act="${1:-}"; local minsp="${2:-}"
  if [ -z "$act" ]; then echo "用法: set-vad <activation 如0.7> [min_speech 如0.15]"; exit 1; fi
  cp .env .env.bak   # 备份(覆盖式,只留最近一次)
  sed -i '/^VAD_ACTIVATION_THRESHOLD=/d' .env
  echo "VAD_ACTIVATION_THRESHOLD=$act" >> .env
  if [ -n "$minsp" ]; then
    sed -i '/^VAD_MIN_SPEECH_DURATION=/d' .env
    echo "VAD_MIN_SPEECH_DURATION=$minsp" >> .env
  fi
  echo "✅ 已写 .env: activation=$act${minsp:+ min_speech=$minsp}(原 .env → .env.bak)"
  _stop; _start
}

case "${1:-status}" in
  restart) _stop; _start ;;
  stop)    _stop; echo "✅ 已停 worker" ;;
  status)  _status ;;
  set-vad) shift; _set_vad "$@" ;;
  reset)   cp .env .env.bak; sed -i '/^VAD_ACTIVATION_THRESHOLD=/d; /^VAD_MIN_SPEECH_DURATION=/d' .env; echo "✅ 删 .env VAD 覆盖,回代码默认 0.6/0.15(原 .env → .env.bak)"; _stop; _start ;;
  logs)    tail -n "${2:-30}" "$LOG" 2>/dev/null || true ;;
  *) echo "用法: $0 {status|restart|stop|set-vad <act> [min_speech]|reset|logs [N]}"; exit 1 ;;
esac
