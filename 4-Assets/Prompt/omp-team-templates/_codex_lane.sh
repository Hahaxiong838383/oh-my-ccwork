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
#
# key 来源: ~/.gateway.env 的 CODEX_API_GATEWAY_KEY (chmod 600,home 目录不入 git)
#   只 grep 提取 CODEX_*,不 source 整个文件 —— 避免图像网关的 OPENAI_BASE_URL 污染 omp
#
# 注: curl 主路是「prompt→文本」对话(非 agentic 改文件),team 双发/三发产出本就是文本
#     交 cc 综合挑优,故无损;且 A3 不再 agentic 改 repo,反而消除与 A1 grok(--cwd) 写冲突。
#
# 调试旋钮: CODEX_FORCE_FALLBACK=1 强制跳过 API 主路走降级(验证降级路)

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

  # ── 降级: omp 订阅 OAuth gpt-5.4 (独立路径,最稳) ──
  export PATH="$HOME/.bun/bin:$PATH"
  omp -p --model openai-codex/gpt-5.4 --thinking high --auto-approve \
    --no-extensions --no-skills --no-rules \
    "$prompt" > "$out" 2>>"$err"
}
