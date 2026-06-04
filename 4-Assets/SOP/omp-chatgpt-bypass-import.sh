#!/usr/bin/env bash
# 用途：把 ~/.codex/auth.json 的 ChatGPT Plus/Pro 订阅凭据旁路导入 omp,跳过 OAuth flow
# 适用：装好 omp 后想用 ChatGPT 订阅调 gpt-5.4 等 codex 模型,但 omp auth-broker login 因 readline 死链不好走
# 前提：~/.codex/auth.json 存在且 refresh_token 还有效（codex CLI 已登录过 ChatGPT 账户）
# 原理：codex CLI 与 omp openai-codex provider 都识别 codex 凭据格式
#       (omp CLIPROXY_TYPE_TO_PROVIDER 内置 codex→openai-codex 映射)
#       OAuth refresh_token 在 omp 里可直接换 access_token
# 增量(vs grok 那次): ~/.codex/auth.json 没显式 expired 字段,要从 JWT access_token 的 exp claim 解
# 沉淀：2026-06-04 cc 首次走通,见 RECENT_EVENTS / project_omp_grok43.md

set -euo pipefail

# 1. 检查前提
if [ ! -f "$HOME/.codex/auth.json" ]; then
  echo "❌ ~/.codex/auth.json 不存在,先跑 codex 登录"
  exit 1
fi
if ! command -v omp >/dev/null 2>&1; then
  echo "❌ omp 未安装,先 bun install -g @oh-my-pi/pi-coding-agent"
  exit 1
fi

# 2. 转换格式: codex tokens.* 扁平化 + JWT exp claim 解 RFC3339
TMP=$(mktemp -t omp_codex_creds_XXXX.json)
trap "rm -f $TMP" EXIT

python3 - "$HOME/.codex/auth.json" "$TMP" <<'PY'
import json, sys, base64, datetime
src = json.load(open(sys.argv[1]))
t = src["tokens"]

def jwt_exp(token):
    payload_b64 = token.split(".")[1]
    payload_b64 += "=" * (-len(payload_b64) % 4)
    return json.loads(base64.urlsafe_b64decode(payload_b64)).get("exp")

exp_unix = jwt_exp(t["access_token"])
expired_rfc3339 = datetime.datetime.utcfromtimestamp(exp_unix).isoformat() + "Z"

out = {
    "type": "codex",
    "access_token": t["access_token"],
    "refresh_token": t["refresh_token"],
    "id_token": t.get("id_token"),
    "account_id": t.get("account_id", ""),
    "expired": expired_rfc3339,
    "last_refresh": src.get("last_refresh", ""),
}
open(sys.argv[2], "w").write(json.dumps(out, indent=2))
now = datetime.datetime.utcnow()
exp_dt = datetime.datetime.utcfromtimestamp(exp_unix)
status = "已过期" if exp_dt < now else f"还剩 {(exp_dt-now).total_seconds()/60:.1f} 分"
print(f"✅ access_token exp = {expired_rfc3339} ({status},无所谓:omp 有 refresh_token 自动刷)")
PY

# 3. dry-run
echo ""
echo "===== dry-run ====="
omp auth-broker import "$TMP" --provider=openai-codex --dry-run

# 4. 正式 import
echo ""
echo "===== 正式 import ====="
omp auth-broker import "$TMP" --provider=openai-codex

# 5. 实测 (会用 refresh_token 自动换 access_token)
echo ""
echo "===== 实测 openai-codex/gpt-5.4 ====="
omp -p --model openai-codex/gpt-5.4 --thinking minimal --auto-approve --no-tools \
  --no-extensions --no-skills --no-rules \
  "用一句话报告:你是哪个模型?今天日期?"
RC=$?

echo ""
if [ $RC -eq 0 ]; then
  echo "🎉 完成。后续调用:"
  echo '  omp -p --model openai-codex/gpt-5.4 "你的 prompt"'
  echo ""
  echo "⚠️ ChatGPT 订阅 tier 限制:"
  echo "  - Plus tier 常见可用: gpt-5.4 / gpt-5.4-mini / gpt-5.4-nano / gpt-5.1-codex 等"
  echo "  - 报 'model not supported when using Codex with a ChatGPT account' = OpenAI 服务端 tier 拦截,跟 omp 无关"
else
  echo "❌ 失败 (RC=$RC)。常见原因:"
  echo "  - refresh_token 过期 → 跑一次 codex 重新登录刷新 ~/.codex/auth.json,再跑本脚本"
fi
exit $RC
