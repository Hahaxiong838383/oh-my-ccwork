#!/usr/bin/env bash
# 起 safety-arena 服务,接 OpenAI 兼容网关做"真实生成"(Web 里"真实生成"入口可用)。
# 用法:  GEMINI_PROXY_URL=<你的网关/v1> GEMINI_API_KEY=<你的key> bash scripts/serve-live.sh
#        然后浏览器开 http://127.0.0.1:8800/  →  在"自己输入一句话"框打字 → 点"▶ 真实生成"
#
# 凭证只从环境变量读,绝不硬编码、不进 git。可放本地 .env / .gateway.env(已 gitignore)后 source 再跑。
set -e
cd "$(dirname "$0")/.."

# 必填:你的 OpenAI 兼容网关(如 https://your-gateway.example.com/v1)与 API key,走环境变量传入。
export GEMINI_PROXY_URL="${GEMINI_PROXY_URL:-}"
export GEMINI_DEFAULT_MODEL="${GEMINI_DEFAULT_MODEL:-gemini-2.5-flash}"
export SAFETY_ARENA_CLF_MODEL="${SAFETY_ARENA_CLF_MODEL:-gemini-2.5-flash-lite}"
export GEMINI_API_KEY="${GEMINI_API_KEY:-}"
export no_proxy='*' NO_PROXY='*'

if [ -z "$GEMINI_PROXY_URL" ] || [ -z "$GEMINI_API_KEY" ]; then
  echo "⚠️  GEMINI_PROXY_URL / GEMINI_API_KEY 未设置(用环境变量传入)。真实生成会返回 503;纯 mock 重放不受影响。"
fi
echo "→ 浏览器开 http://127.0.0.1:${PORT:-8800}/   (生成=$GEMINI_DEFAULT_MODEL  分类器=$SAFETY_ARENA_CLF_MODEL)"
exec uv run python -m safety_arena.server
