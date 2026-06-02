#!/usr/bin/env bash
# 用途：把 ~/.grok/auth.json 的 SuperGrok 订阅凭据旁路导入 omp,跳过 OAuth flow
# 适用：装好 omp 后想用 SuperGrok 订阅调 xai-oauth/grok-4.3 等模型,但 omp auth-broker login 因 readline 死链不好走
# 前提：~/.grok/auth.json 存在且 refresh_token 还有效（grok-build CLI 已登录过同账户）
# 原理：grok-build 与 omp 共用同一个 xAI OAuth client_id b1a00492-073a-47ea-816f-4c329264a828
#       scope 完全一致（openid profile email offline_access grok-cli:access api:access）
#       所以 grok 的 refresh_token 在 omp 里可直接换 access_token
# 沉淀：2026-06-02 cc 首次走通,见 RECENT_EVENTS / project_omp_grok43.md

set -euo pipefail

# 1. 检查前提
if [ ! -f "$HOME/.grok/auth.json" ]; then
  echo "❌ ~/.grok/auth.json 不存在,先跑 grok 登录"
  exit 1
fi
if ! command -v omp >/dev/null 2>&1; then
  echo "❌ omp 未安装,先 bun install -g @oh-my-pi/pi-coding-agent (或装 bun 后再装)"
  exit 1
fi

# 2. 转换格式:grok 用 "key" 装 access_token,顶层是 issuer::client_id 索引;omp 期望扁平 CliProxy 结构
TMP=$(mktemp -t omp_xai_creds_XXXX.json)
trap "rm -f $TMP" EXIT

python3 - "$HOME/.grok/auth.json" "$TMP" <<'PY'
import json, sys
src = json.loads(open(sys.argv[1]).read())
inner = next(iter(src.values()))
out = {
    "type": "xai-oauth",
    "access_token": inner["key"],
    "refresh_token": inner["refresh_token"],
    "expired": inner["expires_at"],
    "email": inner.get("email", ""),
    "account_id": inner.get("user_id", ""),
}
open(sys.argv[2], "w").write(json.dumps(out, indent=2))
print(f"✅ 已转换 grok→omp 格式 (email={out['email']}, expired={out['expired']})")
PY

# 3. dry-run 看一眼
echo ""
echo "===== dry-run ====="
omp auth-broker import "$TMP" --provider=xai-oauth --dry-run

# 4. 正式 import
echo ""
echo "===== 正式 import ====="
omp auth-broker import "$TMP" --provider=xai-oauth

# 5. 实测 (会用 refresh_token 自动换 access_token)
echo ""
echo "===== 实测 xai-oauth/grok-4.3 ====="
omp -p --model xai-oauth/grok-4.3 --auto-approve --no-tools \
  --no-extensions --no-skills --no-rules \
  "用一句话报告:你是哪个模型?今天日期?"
RC=$?

echo ""
if [ $RC -eq 0 ]; then
  echo "🎉 完成。后续调用:"
  echo '  PATH="$HOME/.bun/bin:$PATH" omp -p --model xai-oauth/grok-4.3 --thinking high "你的 prompt"'
else
  echo "❌ 失败 (RC=$RC)。常见原因:"
  echo "  - refresh_token 过期 → 跑一次 grok CLI 重新登录刷新 ~/.grok/auth.json,再跑本脚本"
  echo "  - 模型名漏 xai-oauth/ 前缀 → 模糊匹配到 kilo 报 'No API key for kilo'"
fi
exit $RC
