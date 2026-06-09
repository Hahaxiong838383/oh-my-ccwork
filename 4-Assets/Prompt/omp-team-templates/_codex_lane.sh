#!/usr/bin/env bash
# 被 code-2send.sh / review-3send.sh source。提供 run_codex_lane()。
#
# team codex lane = 「API 网关主路 + 订阅 OAuth 降级」(川哥钦定 2026-06-09):
#   主路: curl https://10521052.xyz/v1 (cc-switch 同款网关) model=gpt-5.5 + reasoning_effort=high
#         直连 —— 强制 --noproxy + unset proxy env(网关在国内,不走 xray 代理 10808)
#   降级: omp -p --model openai-codex/gpt-5.4 (ChatGPT 订阅 OAuth,独立路径)
#         用 5.4 不用 5.5 —— 订阅 5.5 常卡死,5.4 最稳 (川哥实测)
#
# key 来源: ~/.gateway.env 的 CODEX_API_GATEWAY_KEY (chmod 600,home 目录不入 git)
#   只 grep 提取 CODEX_* ,不 source 整个文件 —— 避免图像网关的 OPENAI_BASE_URL 污染 omp
#
# 注: curl 主路是「prompt→文本」对话,不带 agentic 改文件能力。team 双发/三发的产出
#     本就是文本(/tmp/a-gpt.md 等)交给 cc 综合挑优,故无损;且 A3 不再 agentic 改 repo,
#     反而消除与 A1 grok(--cwd repo) 的潜在写冲突。

# run_codex_lane <prompt-text> <out-file> <err-file> [label]
run_codex_lane () {
  local prompt="$1" out="$2" err="$3" label="${4:-codex}"
  : > "$err"

  # 只取 CODEX_* 凭据(不 source,防 OPENAI_BASE_URL 污染 omp 降级)
  local key="" base="https://10521052.xyz/v1"
  if [ -f "$HOME/.gateway.env" ]; then
    key=$(grep -E '^CODEX_API_GATEWAY_KEY=' "$HOME/.gateway.env" | head -1 | cut -d= -f2-)
    local b
    b=$(grep -E '^CODEX_API_GATEWAY_BASE_URL=' "$HOME/.gateway.env" | head -1 | cut -d= -f2-)
    [ -n "$b" ] && base="$b"
  fi

  # ── 主路: API 网关 gpt-5.5 (直连, reasoning=high) ──
  if [ -n "$key" ] && [ "${CODEX_FORCE_FALLBACK:-0}" != 1 ]; then
    local body http
    body=$(python3 -c "import json,sys;print(json.dumps({'model':'gpt-5.5','messages':[{'role':'user','content':sys.argv[1]}],'max_tokens':16000,'reasoning_effort':'high'}))" "$prompt")
    http=$(env -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY -u https_proxy -u http_proxy -u all_proxy \
      curl -s --noproxy '*' --max-time 600 \
        -H "Authorization: Bearer $key" -H "Content-Type: application/json" \
        -d "$body" "$base/chat/completions" -o "$out.raw" -w '%{http_code}' 2>>"$err")
    if [ "$http" = 200 ] && python3 -c "
import json,sys
d=json.load(open(sys.argv[1],encoding='utf-8'))
c=(d['choices'][0]['message'].get('content') or '').strip()
open(sys.argv[2],'w',encoding='utf-8').write(c + '\n')
sys.exit(0 if c else 1)
" "$out.raw" "$out" 2>>"$err"; then
      echo "[$label] ✅ API 网关 gpt-5.5 (reasoning=high)" >&2
      rm -f "$out.raw"
      return 0
    fi
    echo "[$label] ⚠️ API 主路失败 (HTTP=$http) → 降级 omp 订阅 gpt-5.4" | tee -a "$err" >&2
    rm -f "$out.raw"
  else
    echo "[$label] ℹ️ 跳过 API 主路(无 key 或强制降级) → omp 订阅 gpt-5.4" >&2
  fi

  # ── 降级: omp 订阅 OAuth gpt-5.4 (独立路径,最稳) ──
  export PATH="$HOME/.bun/bin:$PATH"
  omp -p --model openai-codex/gpt-5.4 --thinking high --auto-approve \
    --no-extensions --no-skills --no-rules \
    "$prompt" > "$out" 2>>"$err"
}
