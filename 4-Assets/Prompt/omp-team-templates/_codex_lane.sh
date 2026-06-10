#!/usr/bin/env bash
# 被 code-2send.sh / review-3send.sh source。提供 run_codex_lane()。
#
# team codex lane = 「API 网关流式主路 + 订阅 OAuth 降级」(川哥钦定 2026-06-09,流式加固 2026-06-10):
#   主路: curl https://10521052.xyz/v1 (cc-switch 同款网关) gpt-5.5 + reasoning_effort=high
#         ★ stream:true 流式 —— 网关在 Cloudflare 后,源站 ~100s 不响应即回 HTTP 524。
#           非流式重 reasoning 任务憋满 ~125s 无字节必 524 卡死(2026-06-10 实测根因);
#           流式持续吐 SSE 字节刷新 CF 空闲计时器绕过 524(IDE codex 走同网关亦走流式 /responses)。
#         直连: 强制 --noproxy + unset proxy(国内网关不走 xray 代理 10808)
#         --connect-timeout 15 + --max-time 300 硬上限(防中途 stall 无限等)
#   降级: omp -p --model openai-codex/gpt-5.4 (ChatGPT 订阅 OAuth,独立路径;订阅 5.5 常卡死故用 5.4)
#         ★ watchdog 硬超时(默认 480s,加固 2026-06-10): omp/codex 无 stream-idle timeout,
#           上游流式响应中途阻塞会永久挂(进程不退/不报错,见 memory feedback_codex_exec_hang_no_stream_timeout),
#           裸 omp 会拖死调用方 review-3send/code-2send 的 wait。超时递归杀进程树
#           (macOS 无 setsid,pkill -P 递归)后 return 2,调用方按失败处理。
#           注: omp -p 正文常在结束时一次性落盘,不能照搬 codex_run.sh 的「字节停滞」判 hang
#           (会误杀正常慢跑),只用总时长硬上限。
#
# key 来源: ~/.gateway.env 的 CODEX_API_GATEWAY_KEY (chmod 600,home 目录不入 git)
#   只 grep 提取 CODEX_*,不 source 整个文件 —— 避免图像网关的 OPENAI_BASE_URL 污染 omp
#
# 注: curl 主路是「prompt→文本」对话(非 agentic 改文件),team 双发/三发产出本就是文本
#     交 cc 综合挑优,故无损;且 A3 不再 agentic 改 repo,反而消除与 A1 grok(--cwd) 写冲突。
#
# 调试旋钮: CODEX_FORCE_FALLBACK=1 强制跳过 API 主路走降级(验证降级路)
#           CODEX_FALLBACK_TIMEOUT=N 降级 omp 硬超时秒数(默认 480)
#           CODEX_FALLBACK_CMD='...' 降级命令测试替身(模拟挂死/失败,不真调 omp)

# macOS 无 setsid,递归 pkill -P 杀进程树(防 bun/tls 子进程残留孤儿)
_codex_lane_kill_tree () {
  local root_pid="$1" c
  for c in $(pgrep -P "$root_pid" 2>/dev/null); do _codex_lane_kill_tree "$c"; done
  kill -TERM "$root_pid" 2>/dev/null
}
_codex_lane_kill_tree_force () {
  local root_pid="$1" c
  for c in $(pgrep -P "$root_pid" 2>/dev/null); do _codex_lane_kill_tree_force "$c"; done
  kill -KILL "$root_pid" 2>/dev/null
}

# run_codex_lane <prompt-text> <out-file> <err-file> [label]
run_codex_lane () {
  local prompt="$1" out="$2" err="$3" label="${4:-codex}"
  : > "$err"

  # 只取 CODEX_* 凭据(不 source,防 OPENAI_BASE_URL 污染 omp 降级)
  local key="" base="https://10521052.xyz/v1"
  if [ -f "$HOME/.gateway.env" ]; then
    key=$(grep -E '^CODEX_API_GATEWAY_KEY=' "$HOME/.gateway.env" | head -1 | cut -d= -f2-)
    local b; b=$(grep -E '^CODEX_API_GATEWAY_BASE_URL=' "$HOME/.gateway.env" | head -1 | cut -d= -f2-)
    [ -n "$b" ] && base="$b"
  fi

  # ── 主路: API 网关 gpt-5.5 流式 (绕过 CF 524) ──
  if [ -n "$key" ] && [ "${CODEX_FORCE_FALLBACK:-0}" != 1 ]; then
    local body http crc raw="$out.sse"
    body=$(python3 -c "import json,sys;print(json.dumps({'model':'gpt-5.5','messages':[{'role':'user','content':sys.argv[1]}],'max_tokens':16000,'reasoning_effort':'high','stream':True}))" "$prompt")
    http=$(env -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY -u https_proxy -u http_proxy -u all_proxy \
      curl -sN --noproxy '*' --connect-timeout 15 --max-time 300 \
        -H "Authorization: Bearer $key" -H "Content-Type: application/json" \
        -d "$body" "$base/chat/completions" -o "$raw" -w '%{http_code}' 2>>"$err")
    crc=$?
    # 解析 SSE: 拼 delta.content(跳过 reasoning_content),写 out;成功条件 http=200 且正文非空
    if [ "$http" = 200 ] && python3 -c "
import json,sys
buf=[]
for line in open(sys.argv[1],encoding='utf-8'):
    line=line.strip()
    if not line.startswith('data:'): continue
    payload=line[5:].strip()
    if payload=='[DONE]': break
    try: d=json.loads(payload)
    except Exception: continue
    ch=d.get('choices') or [{}]
    delta=ch[0].get('delta',{}) if ch else {}
    c=delta.get('content')
    if c: buf.append(c)
text=''.join(buf).strip()
open(sys.argv[2],'w',encoding='utf-8').write(text+'\n')
sys.exit(0 if text else 1)
" "$raw" "$out" 2>>"$err"; then
      echo "[$label] ✅ API 网关 gpt-5.5 (流式 reasoning=high)" >&2
      rm -f "$raw"
      return 0
    fi
    echo "[$label] ⚠️ API 主路失败 (http=$http curl_rc=$crc) → 降级 omp 订阅 gpt-5.4" | tee -a "$err" >&2
    rm -f "$raw"
  else
    echo "[$label] ℹ️ 跳过 API 主路(无 key 或强制降级) → omp 订阅 gpt-5.4" >&2
  fi

  # ── 降级: omp 订阅 OAuth gpt-5.4 (独立路径,最稳) + 硬超时 watchdog 防永久挂 ──
  export PATH="$HOME/.bun/bin:$PATH"
  local fb_timeout="${CODEX_FALLBACK_TIMEOUT:-480}" fb_interval=15
  local fb_pid fb_elapsed=0 fb_rc fb_bytes
  [ "$fb_interval" -gt "$fb_timeout" ] && fb_interval="$fb_timeout"   # 测试用短超时时保持灵敏

  if [ -n "${CODEX_FALLBACK_CMD:-}" ]; then
    bash -c "$CODEX_FALLBACK_CMD" > "$out" 2>>"$err" &
  else
    omp -p --model openai-codex/gpt-5.4 --thinking high --auto-approve \
      --no-extensions --no-skills --no-rules \
      "$prompt" > "$out" 2>>"$err" &
  fi
  fb_pid=$!

  while kill -0 "$fb_pid" 2>/dev/null; do
    sleep "$fb_interval"
    fb_elapsed=$((fb_elapsed + fb_interval))
    if [ "$fb_elapsed" -ge "$fb_timeout" ] && kill -0 "$fb_pid" 2>/dev/null; then
      echo "[$label] ❌ 降级 omp gpt-5.4 超 ${fb_timeout}s 未退出(疑似上游流挂死),kill 进程树 pid=$fb_pid" | tee -a "$err" >&2
      _codex_lane_kill_tree "$fb_pid"; sleep 2; _codex_lane_kill_tree_force "$fb_pid"
      wait "$fb_pid" 2>/dev/null
      return 2
    fi
  done
  wait "$fb_pid" 2>/dev/null; fb_rc=$?

  fb_bytes=$(wc -c < "$out" 2>/dev/null | tr -d ' '); fb_bytes=${fb_bytes:-0}
  if [ "$fb_rc" -eq 0 ] && [ "$fb_bytes" -gt 0 ]; then
    echo "[$label] ✅ omp 订阅 gpt-5.4 (降级路, ${fb_bytes}B)" >&2
    return 0
  fi
  [ "$fb_rc" -eq 0 ] && fb_rc=1   # rc=0 但输出为空 → 视为失败
  echo "[$label] ❌ 降级 omp gpt-5.4 失败 (rc=$fb_rc, 输出 ${fb_bytes}B)" | tee -a "$err" >&2
  return "$fb_rc"
}
