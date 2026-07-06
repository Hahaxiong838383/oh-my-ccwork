#!/usr/bin/env bash
# 被 code-2send.sh / review-3send.sh source。提供 run_codex_lane()。
#
# team codex lane = 「三 API 网关流式主路 + 订阅 OAuth 兜底」四级降级链
#   (川哥钦定 2026-06-09,流式加固 06-10,三网关 06-15,主次重排 06-16):
#   ① 网关2: curl https://cc-sub2.whtaibang.top/v1 gpt-5.5 (黎夏,川哥 06-10 提供) → 主路
#      ⚠️ 其 WAF 拦 Python-urllib UA(curl/Bun/node/codex UA 均放行);/responses 不认 max_output_tokens
#   ② 网关3: curl https://api-direct.hahaxiong.top/v1 gpt-5.5 (川哥日本自建 CLIProxyAPI,聚合 team+gemini+grok)
#      实测最快最稳(轻请求 1.75s),自建可控,见 memory reference_japan_codex_relay
#   ③ 网关1: curl https://10521052.xyz/v1 (cc-switch 同款) gpt-5.5 → 垫底
#      ⚠️ 2026-06-16 曾突发 403「无权访问 20X专用通道 分组」(账号被移出分组,非限流),同日已修复恢复 200,
#         降垫底;403 修好(套餐/分组恢复)后自动复用。CODEX_SKIP_GW1=1 可整个跳过它
#   ④ 订阅: omp -p --model openai-codex/gpt-5.4 (ChatGPT OAuth,独立路径;订阅 5.5 常卡死故用 5.4)
#
#   ★ stream:true 流式 —— 两网关都在 Cloudflare 后,源站 ~100s 不响应即回 HTTP 524。
#     非流式重 reasoning 任务憋满 ~125s 无字节必 524 卡死(2026-06-10 实测根因);
#     流式持续吐 SSE 字节刷新 CF 空闲计时器绕过 524。
#   直连: 强制 --noproxy + unset proxy(国内网关不走 xray 代理 10808)
#   --connect-timeout 15 + --max-time 900 硬上限(防中途 stall 无限等;可用 CODEX_API_MAX_TIME 覆盖)
#     ⚠️ 2026-06-11 实证: 旧值 300s 对长文撰写任务(48KB prompt + reasoning high 输出 13K字)是压线值,
#        再重一点必被 curl 硬掐 → 调 900s;且超时/掐断时走「部分内容抢救」:
#        raw SSE 里已拼出 ≥2000B 正文则写 out + 尾注 [TRUNCATED-RESCUED] 并算成功,不再整段丢弃降级
#   ★ 订阅路 watchdog 硬超时(默认 480s): omp/codex 无 stream-idle timeout,
#     上游流式响应中途阻塞会永久挂(见 memory feedback_codex_exec_hang_no_stream_timeout),
#     裸 omp 会拖死调用方的 wait。超时递归杀进程树(macOS 无 setsid,pkill -P 递归)后 return 2。
#     注: omp -p 正文常在结束时一次性落盘,不能照搬 codex_run.sh 的「字节停滞」判 hang。
#
# key 来源: ~/.gateway.env (chmod 600,home 目录不入 git)
#   网关1=CODEX_API_GATEWAY_KEY / 网关2=CODEX_API_GATEWAY2_KEY / 网关3=CODEX_API_GATEWAY3_KEY (各带 _BASE_URL)
#   Smart 灰度=CODEX_API_SMART_KEY / CODEX_API_SMART_BASE_URL / CODEX_SMART_CANARY_PERCENT
#   只 grep 提取 CODEX_*,不 source 整个文件 —— 避免图像网关的 OPENAI_BASE_URL 污染 omp
#
# 注: curl 主路是「prompt→文本」对话(非 agentic 改文件),team 双发/三发产出本就是文本
#     交 cc 综合挑优,故无损;且 A3 不再 agentic 改 repo,反而消除与 A1 grok(--cwd) 写冲突。
#
# 调试旋钮: CODEX_FORCE_FALLBACK=1 跳过全部 API 网关直接走订阅(验证兜底路)
#           CODEX_SKIP_GW1=1     跳过垫底网关1(默认仍尝试;设1可省一次往返)
#           CODEX_FALLBACK_TIMEOUT=N 订阅 omp 硬超时秒数(默认 480)
#           CODEX_FALLBACK_CMD='...' 订阅命令测试替身(模拟挂死/失败,不真调 omp)
#           CODEX_API_MAX_TIME=N  网关 curl 总时长硬上限秒数(默认 900)
#           CODEX_SMART_CANARY_PERCENT=N  0-100,命中时先试 smart-router,失败自动回原链路
#           CODEX_RESCUE_MIN=N    截断抢救的最小正文字节数(默认 2000,低于此判失败降级)

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

# _codex_lane_api_try <base> <key> <gwtag> <prompt> <out> <err> <label>
# 单网关流式尝试: 完整成功(收到 finish 标志且正文非空) return 0
#   截断抢救: curl 超时/被掐但 raw 已拼出 ≥CODEX_RESCUE_MIN 字节正文 → 写 out + [TRUNCATED-RESCUED] 尾注, return 0
_codex_lane_api_try () {
  local base="$1" key="$2" gwtag="$3" prompt="$4" out="$5" err="$6" label="$7"
  local body http crc pyrc raw="$out.sse"
  local max_time="${CODEX_API_MAX_TIME:-900}" rescue_min="${CODEX_RESCUE_MIN:-2000}"
  echo "[$label] ▶️ API $gwtag gpt-5.5 起跑 (max-time=${max_time}s)" >&2
  body=$(python3 -c "import json,sys;print(json.dumps({'model':'gpt-5.5','messages':[{'role':'user','content':sys.argv[1]}],'max_tokens':16000,'reasoning_effort':'high','stream':True}))" "$prompt")
  http=$(env -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY -u https_proxy -u http_proxy -u all_proxy \
    curl -sN --noproxy '*' --connect-timeout 15 --max-time "$max_time" \
      -H "Authorization: Bearer $key" -H "Content-Type: application/json" \
      -d "$body" "$base/chat/completions" -o "$raw" -w '%{http_code}' 2>>"$err")
  crc=$?
  # 解析 SSE: 拼 delta.content(跳过 reasoning_content),写 out
  # exit 0=完整(见 finish/[DONE] 且正文非空) / 2=截断但正文 ≥rescue_min / 1=不可用
  python3 -c "
import json,sys
buf=[];finished=False
for line in open(sys.argv[1],encoding='utf-8',errors='ignore'):
    line=line.strip()
    if not line.startswith('data:'): continue
    payload=line[5:].strip()
    if payload=='[DONE]':
        finished=True; break
    try: d=json.loads(payload)
    except Exception: continue
    ch=d.get('choices') or [{}]
    if ch and ch[0].get('finish_reason'): finished=True
    delta=ch[0].get('delta',{}) if ch else {}
    c=delta.get('content')
    if c: buf.append(c)
text=''.join(buf).strip()
rescue_min=int(sys.argv[3])
if not text:
    sys.exit(1)
if finished:
    open(sys.argv[2],'w',encoding='utf-8').write(text+'\n')
    sys.exit(0)
if len(text.encode('utf-8'))>=rescue_min:
    open(sys.argv[2],'w',encoding='utf-8').write(text+'\n\n> ⚠️ [TRUNCATED-RESCUED] 流在此被截断（curl 超时/网络掐断），以上为已接收部分。\n')
    sys.exit(2)
sys.exit(1)
" "$raw" "$out" "$rescue_min" 2>>"$err"
  pyrc=$?
  if [ "$http" = 200 ] && [ "$pyrc" = 0 ]; then
    echo "[$label] ✅ API $gwtag gpt-5.5 (流式 reasoning=high)" >&2
    rm -f "$raw"
    return 0
  fi
  if [ "$pyrc" = 2 ]; then
    echo "[$label] ⚠️✅ API $gwtag 流被截断,已抢救部分正文 (http=$http curl_rc=$crc, out=$(wc -c < "$out" | tr -d ' ')B 含 TRUNCATED 标注)" | tee -a "$err" >&2
    rm -f "$raw"
    return 0
  fi
  echo "[$label] ⚠️ API $gwtag 失败 (http=$http curl_rc=$crc pyrc=$pyrc)" | tee -a "$err" >&2
  rm -f "$raw"
  return 1
}

# run_codex_lane <prompt-text> <out-file> <err-file> [label]
run_codex_lane () {
  local prompt="$1" out="$2" err="$3" label="${4:-codex}"
  : > "$err"

  # 只取 CODEX_* 凭据(不 source,防 OPENAI_BASE_URL 污染 omp 降级)
  local smart_key="" smart_base="https://smart-api.hahaxiong.top/v1" smart_pct="${CODEX_SMART_CANARY_PERCENT:-0}"
  local key1="" base1="https://10521052.xyz/v1"
  local key2="" base2="https://cc-sub2.whtaibang.top/v1"
  local key3="" base3="https://api-direct.hahaxiong.top/v1"
  if [ -f "$HOME/.gateway.env" ]; then
    smart_key=$(grep -E '^CODEX_API_SMART_KEY=' "$HOME/.gateway.env" | head -1 | cut -d= -f2-)
    key1=$(grep -E '^CODEX_API_GATEWAY_KEY=' "$HOME/.gateway.env" | head -1 | cut -d= -f2-)
    key2=$(grep -E '^CODEX_API_GATEWAY2_KEY=' "$HOME/.gateway.env" | head -1 | cut -d= -f2-)
    key3=$(grep -E '^CODEX_API_GATEWAY3_KEY=' "$HOME/.gateway.env" | head -1 | cut -d= -f2-)
    local b
    b=$(grep -E '^CODEX_API_SMART_BASE_URL=' "$HOME/.gateway.env" | head -1 | cut -d= -f2-)
    [ -n "$b" ] && smart_base="$b"
    if [ -z "${CODEX_SMART_CANARY_PERCENT+x}" ]; then
      b=$(grep -E '^CODEX_SMART_CANARY_PERCENT=' "$HOME/.gateway.env" | head -1 | cut -d= -f2-)
      [ -n "$b" ] && smart_pct="$b"
    fi
    b=$(grep -E '^CODEX_API_GATEWAY_BASE_URL=' "$HOME/.gateway.env" | head -1 | cut -d= -f2-)
    [ -n "$b" ] && base1="$b"
    b=$(grep -E '^CODEX_API_GATEWAY2_BASE_URL=' "$HOME/.gateway.env" | head -1 | cut -d= -f2-)
    [ -n "$b" ] && base2="$b"
    b=$(grep -E '^CODEX_API_GATEWAY3_BASE_URL=' "$HOME/.gateway.env" | head -1 | cut -d= -f2-)
    [ -n "$b" ] && base3="$b"
  fi

  # ── API 网关链 (2026-07-06 smart-router 灰度): Smart(按百分比) → 网关2 主 → 网关3 → 网关1(垫底) ──
  if [ "${CODEX_FORCE_FALLBACK:-0}" != 1 ]; then
    local smart_roll=100
    if [ -n "$smart_key" ] && [ "$smart_pct" -gt 0 ] 2>/dev/null; then
      [ "$smart_pct" -gt 100 ] && smart_pct=100
      smart_roll=$(( RANDOM % 100 ))
      if [ "$smart_roll" -lt "$smart_pct" ]; then
        _codex_lane_api_try "$smart_base" "$smart_key" "SmartRouter(${smart_pct}% canary)" "$prompt" "$out" "$err" "$label" && return 0
        echo "[$label] ⚠️ SmartRouter 灰度失败 → 回落原 API 网关链" | tee -a "$err" >&2
      fi
    fi
    if [ -n "$key2" ]; then
      _codex_lane_api_try "$base2" "$key2" "网关2(cc-sub2)" "$prompt" "$out" "$err" "$label" && return 0
    fi
    if [ -n "$key3" ]; then
      _codex_lane_api_try "$base3" "$key3" "网关3(日本cpa)" "$prompt" "$out" "$err" "$label" && return 0
    fi
    if [ -n "$key1" ] && [ "${CODEX_SKIP_GW1:-0}" != 1 ]; then
      _codex_lane_api_try "$base1" "$key1" "网关1(10521052,垫底)" "$prompt" "$out" "$err" "$label" && return 0
    fi
    echo "[$label] ⚠️ API 网关链全失败 → 兜底 omp 订阅 gpt-5.4" | tee -a "$err" >&2
  else
    echo "[$label] ℹ️ 强制跳过 API 网关链 → omp 订阅 gpt-5.4" >&2
  fi

  # ── ③ 兜底: omp 订阅 OAuth gpt-5.4 (独立路径,最稳) + 硬超时 watchdog 防永久挂 ──
  export PATH="$HOME/.bun/bin:$PATH"
  local fb_timeout="${CODEX_FALLBACK_TIMEOUT:-480}" fb_interval=15
  local fb_pid fb_elapsed=0 fb_rc fb_bytes
  [ "$fb_interval" -gt "$fb_timeout" ] && fb_interval="$fb_timeout"   # 测试用短超时时保持灵敏

  if [ -n "${CODEX_FALLBACK_CMD:-}" ]; then
    bash -c "$CODEX_FALLBACK_CMD" > "$out" 2>>"$err" &
  else
    # 评审上下文(调用方 export CODEX_LANE_NO_TOOLS=1)走只读 --no-tools(禁所有工具,纯文本);
    #   写码上下文(code-2send 不设此变量)保留 --auto-approve。codex 主路 curl 本就非 agentic,此处加固兜底 omp。
    local codex_tool_flag="--auto-approve"
    [ "${CODEX_LANE_NO_TOOLS:-0}" = 1 ] && codex_tool_flag="--no-tools"
    omp -p --model openai-codex/gpt-5.4 --thinking high "$codex_tool_flag" \
      --no-extensions --no-skills --no-rules \
      "$prompt" > "$out" 2>>"$err" &
  fi
  fb_pid=$!

  while kill -0 "$fb_pid" 2>/dev/null; do
    sleep "$fb_interval"
    fb_elapsed=$((fb_elapsed + fb_interval))
    if [ "$fb_elapsed" -ge "$fb_timeout" ] && kill -0 "$fb_pid" 2>/dev/null; then
      echo "[$label] ❌ 兜底 omp gpt-5.4 超 ${fb_timeout}s 未退出(疑似上游流挂死),kill 进程树 pid=$fb_pid" | tee -a "$err" >&2
      _codex_lane_kill_tree "$fb_pid"; sleep 2; _codex_lane_kill_tree_force "$fb_pid"
      wait "$fb_pid" 2>/dev/null
      return 2
    fi
  done
  wait "$fb_pid" 2>/dev/null; fb_rc=$?

  fb_bytes=$(wc -c < "$out" 2>/dev/null | tr -d ' '); fb_bytes=${fb_bytes:-0}
  if [ "$fb_rc" -eq 0 ] && [ "$fb_bytes" -gt 0 ]; then
    echo "[$label] ✅ omp 订阅 gpt-5.4 (兜底路, ${fb_bytes}B)" >&2
    return 0
  fi
  [ "$fb_rc" -eq 0 ] && fb_rc=1   # rc=0 但输出为空 → 视为失败
  echo "[$label] ❌ 兜底 omp gpt-5.4 失败 (rc=$fb_rc, 输出 ${fb_bytes}B)" | tee -a "$err" >&2
  return "$fb_rc"
}
