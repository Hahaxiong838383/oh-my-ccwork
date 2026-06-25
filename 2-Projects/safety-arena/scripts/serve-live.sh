#!/usr/bin/env bash
# 起 safety-arena 服务,接小可生产 Gemini(Web 里"真实生成"入口可用)。
# 用法:  bash scripts/serve-live.sh
#        然后浏览器开 http://127.0.0.1:8800/  →  在"自己输入一句话"框打字 → 点"▶ 真实生成(Gemini)"
#
# 凭证从 Keychain 读(gemini-proxy-token),不落盘、不进 git。需要本机 Terminal(SSH 读不到 Keychain)。
set -e
cd "$(dirname "$0")/.."

export GEMINI_PROXY_URL="${GEMINI_PROXY_URL:-http://23.226.135.149:4000/v1}"
export GEMINI_DEFAULT_MODEL="${GEMINI_DEFAULT_MODEL:-gemini-2.5-flash}"
export SAFETY_ARENA_CLF_MODEL="${SAFETY_ARENA_CLF_MODEL:-gemini-2.5-flash-lite}"
export GEMINI_API_KEY="${GEMINI_API_KEY:-$(security find-generic-password -s gemini-proxy-token -a gemini-proxy -w 2>/dev/null)}"
export no_proxy='*' NO_PROXY='*'

if [ -z "$GEMINI_API_KEY" ]; then
  echo "⚠️  GEMINI_API_KEY 没读到(Keychain gemini-proxy-token)。真实生成会返回 503。"
fi
echo "→ 浏览器开 http://127.0.0.1:${PORT:-8800}/   (生成=$GEMINI_DEFAULT_MODEL  分类器=$SAFETY_ARENA_CLF_MODEL)"
exec uv run python -m safety_arena.server
