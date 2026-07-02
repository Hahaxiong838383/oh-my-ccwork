#!/usr/bin/env bash
# team codex lane 降级链(2026-07-01 完善版) — 被 review-3send/4send/code-2send source, 提供 run_codex_lane()
#
# 四级 provider 降级链, 每级内置重试(专治"要多试几次"):
#   网关2 cc-sub2 → 网关3 日本 → 网关1 10521052 → omp 订阅 openai-codex/gpt-5.4
#
# 关键修复(vs 旧简化版, 2026-07-01):
#   ① 流式 stream:true —— 网关在 Cloudflare 后, 源站 ~100s 无响应回 HTTP 524。
#      非流式重 reasoning(effort=high)任务憋满 ~125s 必 524 卡死(实测根因, 见 memory
#      feedback_cf_gateway_524_needs_streaming)。流式持续吐 SSE 字节刷新 CF 空闲计时器绕过。
#      ★ 这是旧版"codex 经常调不动、要多试几次"的头号病根。
#   ② 每级单发重试 —— 瞬时失败(连接超时/5xx/网络抖动)自动重试(默认2次, 退避 2s/4s),
#      把"人肉多试几次"自动化进脚本。确定性失败(401/403 鉴权)不重试, 直接降级下一级(省时间)。
#   ③ 截断抢救 —— curl 超时被掐但已收正文 ≥RESCUE_MIN, 写出 + [TRUNCATED-RESCUED] 标注算成功。
#   ④ 订阅兜底 watchdog —— omp 无 stream-idle timeout, 上游流挂会永久等(见 memory
#      feedback_codex_exec_hang_no_stream_timeout); 超时递归杀进程树后 return 2。
#
# 旋钮: CODEX_GW_RETRY(每级重试数, 默认2) CODEX_API_MAX_TIME(curl硬上限秒, 默认900)
#       CODEX_RESCUE_MIN(抢救最小字节, 默认2000) CODEX_FALLBACK_TIMEOUT(订阅watchdog秒, 默认480)
#       CODEX_FORCE_FALLBACK=1(跳网关直接订阅, 测兜底) CODEX_SKIP_GW1=1(跳垫底网关1)
#       CODEX_LANE_NO_TOOLS=1(订阅路只读 --no-tools, 评审上下文由调用方 export)
# key 来源: ~/.gateway.env(chmod 600) 的 CODEX_API_GATEWAY{,2,3}_KEY(各带 _BASE_URL 可覆盖)
#   只 grep 提取 CODEX_*, 不 source 整个文件(避免图像网关 OPENAI_BASE_URL 污染 omp 兜底)

# 递归杀进程树(macOS 无 setsid, 防 bun/tls 子进程残留孤儿)
_codex_kill_tree () {
  local p="$1" c
  for c in $(pgrep -P "$p" 2>/dev/null); do _codex_kill_tree "$c"; done
  kill -TERM "$p" 2>/dev/null
}
_codex_kill_tree_9 () {
  local p="$1" c
  for c in $(pgrep -P "$p" 2>/dev/null); do _codex_kill_tree_9 "$c"; done
  kill -KILL "$p" 2>/dev/null
}

# 单网关一次流式尝试
#   return 0 = 成功(完整 finish 或 截断抢救 ≥RESCUE_MIN)
#   return 1 = 瞬时失败(连接/超时/5xx/空响应) → 可重试
#   return 3 = 确定性失败(401/403 鉴权权限) → 不重试, 直接降级
_codex_gw_once () {
  local base="$1" key="$2" tag="$3" prompt="$4" out="$5" err="$6" label="$7"
  local raw="$out.sse" http crc pyrc
  local max_time="${CODEX_API_MAX_TIME:-900}" rescue_min="${CODEX_RESCUE_MIN:-2000}"
  local body
  body=$(python3 -c "import json,sys;print(json.dumps({'model':'gpt-5.5','messages':[{'role':'user','content':sys.argv[1]}],'max_tokens':16000,'reasoning_effort':'high','stream':True}))" "$prompt")
  http=$(env -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY -u https_proxy -u http_proxy -u all_proxy \
    curl -sN --noproxy '*' --connect-timeout 15 --max-time "$max_time" \
      -H "Authorization: Bearer $key" -H "Content-Type: application/json" \
      -d "$body" "$base/chat/completions" -o "$raw" -w '%{http_code}' 2>>"$err")
  crc=$?
  # 鉴权/权限类确定性失败 → 不重试, 直接降级
  if [ "$http" = 401 ] || [ "$http" = 403 ]; then
    echo "[$label] ⛔ $tag http=$http(鉴权/权限, 不重试)" >&2
    rm -f "$raw"; return 3
  fi
  # 解析 SSE: 拼 delta.content(跳过 reasoning_content)
  python3 -c "
import json,sys
buf=[];finished=False
try: fh=open(sys.argv[1],encoding='utf-8',errors='ignore')
except Exception: sys.exit(1)
for line in fh:
    line=line.strip()
    if not line.startswith('data:'): continue
    p=line[5:].strip()
    if p=='[DONE]': finished=True; break
    try: d=json.loads(p)
    except Exception: continue
    ch=d.get('choices') or [{}]
    if ch and ch[0].get('finish_reason'): finished=True
    delta=ch[0].get('delta',{}) if ch else {}
    c=delta.get('content')
    if c: buf.append(c)
text=''.join(buf).strip()
rescue_min=int(sys.argv[3])
if not text: sys.exit(1)
if finished:
    open(sys.argv[2],'w',encoding='utf-8').write(text+'\n'); sys.exit(0)
if len(text.encode('utf-8'))>=rescue_min:
    open(sys.argv[2],'w',encoding='utf-8').write(text+'\n\n> ⚠️ [TRUNCATED-RESCUED] 流被截断(超时/网络掐断), 以上为已接收部分。\n'); sys.exit(2)
sys.exit(1)
" "$raw" "$out" "$rescue_min" 2>>"$err"
  pyrc=$?
  rm -f "$raw"
  if [ "$http" = 200 ] && [ "$pyrc" = 0 ]; then
    echo "[$label] ✅ $tag(流式 reasoning=high)" >&2; return 0
  fi
  if [ "$pyrc" = 2 ]; then
    echo "[$label] ⚠️✅ $tag 截断抢救(http=$http, $(wc -c <"$out" | tr -d ' ')B 含标注)" >&2; return 0
  fi
  echo "[$label] ⚠️ $tag 瞬时失败(http=$http crc=$crc pyrc=$pyrc)" >&2
  return 1
}

# 单网关带重试: 瞬时失败重试(退避), 确定性失败(401/403)直接降级
_codex_gw_retry () {
  local base="$1" key="$2" tag="$3" prompt="$4" out="$5" err="$6" label="$7"
  [ -z "$key" ] && { echo "[$label] ⏭️ $tag key 缺失, 跳过" >&2; return 1; }
  local retries="${CODEX_GW_RETRY:-2}" i=0 rc
  while :; do
    _codex_gw_once "$base" "$key" "$tag" "$prompt" "$out" "$err" "$label"
    rc=$?
    [ "$rc" = 0 ] && return 0
    [ "$rc" = 3 ] && return 1   # 确定性失败, 不浪费重试
    i=$((i+1))
    [ "$i" -gt "$retries" ] && { echo "[$label] ⚠️ $tag 重试 ${retries} 次仍失败 → 降级下一级" >&2; return 1; }
    echo "[$label] 🔄 $tag 第 ${i}/${retries} 次重试(退避 $((i*2))s)..." >&2
    sleep $((i*2))
  done
}

# run_codex_lane <prompt-text> <out-file> <err-file> [label]
run_codex_lane () {
  local prompt="$1" out="$2" err="$3" label="${4:-codex}"
  : > "$err"
  local key1="" key2="" key3=""
  local base1="https://10521052.xyz/v1" base2="https://cc-sub2.whtaibang.top/v1" base3="https://api-direct.hahaxiong.top/v1"
  if [ -f "$HOME/.gateway.env" ]; then
    key1=$(grep -E '^CODEX_API_GATEWAY_KEY=' "$HOME/.gateway.env" | head -1 | cut -d= -f2-)
    key2=$(grep -E '^CODEX_API_GATEWAY2_KEY=' "$HOME/.gateway.env" | head -1 | cut -d= -f2-)
    key3=$(grep -E '^CODEX_API_GATEWAY3_KEY=' "$HOME/.gateway.env" | head -1 | cut -d= -f2-)
    local b
    b=$(grep -E '^CODEX_API_GATEWAY_BASE_URL=' "$HOME/.gateway.env" | head -1 | cut -d= -f2-); [ -n "$b" ] && base1="$b"
    b=$(grep -E '^CODEX_API_GATEWAY2_BASE_URL=' "$HOME/.gateway.env" | head -1 | cut -d= -f2-); [ -n "$b" ] && base2="$b"
    b=$(grep -E '^CODEX_API_GATEWAY3_BASE_URL=' "$HOME/.gateway.env" | head -1 | cut -d= -f2-); [ -n "$b" ] && base3="$b"
  fi

  # ── 网关链(每级带重试): 网关2 主 → 网关3 → 网关1 垫底 ──
  if [ "${CODEX_FORCE_FALLBACK:-0}" != 1 ]; then
    _codex_gw_retry "$base2" "$key2" "网关2(cc-sub2)"      "$prompt" "$out" "$err" "$label" && return 0
    _codex_gw_retry "$base3" "$key3" "网关3(日本)"         "$prompt" "$out" "$err" "$label" && return 0
    if [ "${CODEX_SKIP_GW1:-0}" != 1 ]; then
      _codex_gw_retry "$base1" "$key1" "网关1(10521052垫底)" "$prompt" "$out" "$err" "$label" && return 0
    fi
    echo "[$label] ⚠️ 网关链全失败 → 兜底 omp 订阅 gpt-5.4" >&2
  else
    echo "[$label] ℹ️ 强制跳过网关链(CODEX_FORCE_FALLBACK=1) → omp 订阅" >&2
  fi

  # ── 兜底: omp 订阅 OAuth gpt-5.4(独立路径) + watchdog 防上游流挂死 ──
  export PATH="$HOME/.bun/bin:$PATH"
  local fb_timeout="${CODEX_FALLBACK_TIMEOUT:-480}" fb_int=15 fb_pid fb_el=0 fb_rc
  [ "$fb_int" -gt "$fb_timeout" ] && fb_int="$fb_timeout"
  local tool_flag="--auto-approve"
  [ "${CODEX_LANE_NO_TOOLS:-0}" = 1 ] && tool_flag="--no-tools"
  omp -p --model openai-codex/gpt-5.4 --thinking high "$tool_flag" \
    --no-extensions --no-skills --no-rules "$prompt" > "$out" 2>>"$err" &
  fb_pid=$!
  while kill -0 "$fb_pid" 2>/dev/null; do
    sleep "$fb_int"; fb_el=$((fb_el + fb_int))
    if [ "$fb_el" -ge "$fb_timeout" ] && kill -0 "$fb_pid" 2>/dev/null; then
      echo "[$label] ❌ 订阅 omp 超 ${fb_timeout}s(疑上游流挂死), 杀进程树 pid=$fb_pid" >&2
      _codex_kill_tree "$fb_pid"; sleep 2; _codex_kill_tree_9 "$fb_pid"; wait "$fb_pid" 2>/dev/null
      return 2
    fi
  done
  wait "$fb_pid" 2>/dev/null; fb_rc=$?
  if [ "$fb_rc" = 0 ] && [ -s "$out" ]; then
    echo "[$label] ✅ omp 订阅 gpt-5.4(兜底, $(wc -c <"$out" | tr -d ' ')B)" >&2; return 0
  fi
  echo "[$label] ❌ codex 全链失败(网关×重试 + 订阅兜底都没出正文)" >&2
  return 1
}
