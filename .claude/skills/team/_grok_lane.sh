#!/usr/bin/env bash
# team grok lane 降级链 — 被 dispatch.sh source, 提供 run_grok_lane()
#
# 定位: 让 grok(xAI grok-4.3)对问题/代码/方案/文档发表独立意见或审查, 纯只读文本输出。
#
# 三级降级链(2026-07-02 加固, 新增②真正独立的 CPA 中转兜底):
#   ① omp xai-oauth/grok-4.3(本机 OAuth, token预检+重试) —— 默认路, 目前最快最稳
#   ② CPA 中转(川哥日本自建 CLIProxyAPI, api-direct.hahaxiong.top, model=grok-4.3)
#      与①同一 SuperGrok 订阅额度, 但服务端独立 OAuth 会话 + 独立网络路径(灰云直连绕CF),
#      能扛住①的本机 token 损坏/omp client bug/本地网络问题(这些故障对②免疫)
#   ③ grok-build CLI(~/.grok/auth.json) —— 与①共享同一 xAI refresh_token 源
#      (omp 的 xai-oauth 凭据本就是从这里旁路导入的, 见 memory project_omp_grok43),
#      独立性弱于②, 仅作最终兜底
#
# 病根(旧版单发无重试无兜底的问题): grok 是纯 OAuth, access token 一进过期窗口就
#   invalid_grant / 空正文, 裸调一发 → 只能人肉多试几次等 launchd(每2h)刷新。
#
# 旋钮: GROK_RETRY(①②各自重试数, 默认2) GROK_THINKING(①的thinking, 默认high)
#       GROK_RELAY_MODEL(②的模型名, 默认grok-4.3)
# key 来源: ~/.gateway.env 的 CODEX_API_GATEWAY3_KEY/_BASE_URL —— 与 codex 网关3 同一个
#   CPA 中转(该服务器一份 key 聚合 gpt/grok/gemini 多家, 只是 model 参数不同), 不重复存secret。
#   详见 ~/Documents/陈川个人站/CPA个人中转-访问信息.md(明文凭据, 仅本机, 不入 git)。
# 注: 本技能只做审查/意见, 全程 --no-tools 只读, 不写文件不改 repo。

_grok_token_precheck () {
  local refresh="$HOME/mycc/4-Assets/SOP/omp-xai-token-refresh.py"
  [ -f "$refresh" ] || return 0
  python3 "$refresh" --if-expiring 600 --quiet 2>/dev/null \
    || echo "[grok] ⚠️ xai token 预检刷新失败(refresh token 可能被吊销) → 真终端跑 bash ~/mycc/4-Assets/SOP/omp-xai-relogin.sh 重登" >&2
}

# CPA 中转单次尝试(OpenAI 兼容协议, 非流式 —— 该端点绕 CF 直连日本源站, 无 524 顾虑)
#   return 0=成功  1=瞬时失败(可重试)  3=确定性失败(401/403, 不重试)
_grok_relay_once () {
  local base="$1" key="$2" prompt="$3" out="$4" err="$5" label="$6" model="$7"
  local body http pyrc
  body=$(python3 -c "import json,sys;print(json.dumps({'model':sys.argv[1],'messages':[{'role':'user','content':sys.argv[2]}]}))" "$model" "$prompt")
  http=$(env -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY -u https_proxy -u http_proxy -u all_proxy \
    curl -s --noproxy '*' --connect-timeout 15 --max-time 120 \
      -H "Authorization: Bearer $key" -H "Content-Type: application/json" \
      -d "$body" "$base/chat/completions" -o "$out.json" -w '%{http_code}' 2>>"$err")
  if [ "$http" = 401 ] || [ "$http" = 403 ]; then
    echo "[$label] ⛔ CPA中转 http=$http(鉴权/权限, 不重试)" >&2
    rm -f "$out.json"; return 3
  fi
  if [ "$http" = 200 ]; then
    python3 -c "
import json,sys
try:
    d=json.load(open(sys.argv[1],encoding='utf-8'))
    text=((d.get('choices') or [{}])[0].get('message') or {}).get('content','').strip()
except Exception:
    sys.exit(1)
if not text: sys.exit(1)
open(sys.argv[2],'w',encoding='utf-8').write(text+'\n')
" "$out.json" "$out" 2>>"$err"
    pyrc=$?
    rm -f "$out.json"
    if [ "$pyrc" = 0 ]; then
      echo "[$label] ✅ CPA中转 grok(model=$model)" >&2
      return 0
    fi
  fi
  echo "[$label] ⚠️ CPA中转瞬时失败(http=$http)" >&2
  rm -f "$out.json" 2>/dev/null
  return 1
}

_grok_relay_retry () {
  local prompt="$1" out="$2" err="$3" label="$4"
  local key="" base="" model="${GROK_RELAY_MODEL:-grok-4.3}"
  if [ -f "$HOME/.gateway.env" ]; then
    key=$(grep -E '^CODEX_API_GATEWAY3_KEY=' "$HOME/.gateway.env" | head -1 | cut -d= -f2-)
    base=$(grep -E '^CODEX_API_GATEWAY3_BASE_URL=' "$HOME/.gateway.env" | head -1 | cut -d= -f2-)
  fi
  base="${base:-https://api-direct.hahaxiong.top/v1}"
  [ -z "$key" ] && { echo "[$label] ⏭️ CPA中转 key 缺失(~/.gateway.env 无 CODEX_API_GATEWAY3_KEY), 跳过" >&2; return 1; }
  local retries="${GROK_RETRY:-2}" i=0 rc
  while :; do
    _grok_relay_once "$base" "$key" "$prompt" "$out" "$err" "$label" "$model"
    rc=$?
    [ "$rc" = 0 ] && return 0
    [ "$rc" = 3 ] && return 1
    i=$((i + 1))
    [ "$i" -gt "$retries" ] && { echo "[$label] ⚠️ CPA中转重试 ${retries} 次仍失败 → 降级下一级" >&2; return 1; }
    echo "[$label] 🔄 CPA中转第 ${i}/${retries} 次重试(退避 $((i * 2))s)..." >&2
    sleep $((i * 2))
  done
}

# run_grok_lane <prompt-text> <out-file> <err-file> [label] [cwd]
#   cwd 建议由调用方传干净临时目录(无 AGENTS.md, 防 omp 误加载 codex 身份误署名); 不传则内部 mktemp。
run_grok_lane () {
  local prompt="$1" out="$2" err="$3" label="${4:-grok}" cwd="${5:-}"
  : > "$err"
  export PATH="$HOME/.bun/bin:$PATH"
  local own_cwd=0
  if [ -z "$cwd" ]; then cwd="$(mktemp -d)"; own_cwd=1; fi
  local retries="${GROK_RETRY:-2}" thinking="${GROK_THINKING:-high}" i=0 rc

  _grok_token_precheck

  # ── ① omp xai-oauth/grok-4.3 带重试(纯只读 --no-tools) ──
  while :; do
    omp -p --model xai-oauth/grok-4.3 --thinking "$thinking" --no-tools \
      --cwd "$cwd" --no-extensions --no-skills --no-rules "$prompt" > "$out" 2>>"$err"
    rc=$?
    if [ "$rc" -eq 0 ] && [ -s "$out" ]; then
      echo "[$label] ✅ omp grok-4.3(thinking=$thinking)" >&2
      [ "$own_cwd" = 1 ] && rm -rf "$cwd"
      return 0
    fi
    i=$((i + 1))
    [ "$i" -gt "$retries" ] && break
    if grep -qiE 'invalid_grant|401|token.*(expired|revoked|refresh)' "$err" 2>/dev/null; then
      echo "[$label] 🔄 grok 疑 token 失效 → 强制刷新后第 ${i}/${retries} 次重试..." >&2
      _grok_token_precheck
    else
      echo "[$label] 🔄 grok omp 第 ${i}/${retries} 次重试(退避 $((i * 2))s)..." >&2
      sleep $((i * 2))
    fi
  done

  # ── ② 兜底: CPA 中转(服务端独立OAuth会话 + 独立网络路径, 真正独立于①) ──
  echo "[$label] ⚠️ omp grok 重试耗尽 → 兜底 CPA 中转" >&2
  if _grok_relay_retry "$prompt" "$out" "$err" "$label"; then
    [ "$own_cwd" = 1 ] && rm -rf "$cwd"
    return 0
  fi

  # ── ③ 最终兜底: grok-build CLI(与①同源 xAI refresh_token, 独立性弱, 仅最后一道) ──
  if [ -x "$HOME/.grok/bin/grok" ]; then
    echo "[$label] ⚠️ CPA中转也失败 → 最终兜底 grok-build CLI" >&2
    local pf; pf="$(mktemp)"; printf '%s' "$prompt" > "$pf"
    "$HOME/.grok/bin/grok" --prompt-file "$pf" -m grok-build --effort high \
      --output-format plain --no-subagents --cwd "$cwd" > "$out" 2>>"$err"
    rc=$?; rm -f "$pf"
    if [ "$rc" -eq 0 ] && [ -s "$out" ]; then
      echo "[$label] ✅ grok-build CLI(最终兜底)" >&2
      [ "$own_cwd" = 1 ] && rm -rf "$cwd"
      return 0
    fi
    echo "[$label] ❌ grok-build 兜底也失败(rc=$rc)" >&2
  else
    echo "[$label] ⚠️ grok-build CLI(~/.grok/bin/grok)不可用, 无最终兜底" >&2
  fi
  [ "$own_cwd" = 1 ] && rm -rf "$cwd"
  echo "[$label] ❌ grok 全链失败(omp×重试 + CPA中转 + grok-build 都没出正文)" >&2
  return 1
}
