#!/usr/bin/env bash
# AI 启蒙护栏验证 runner —— secret 从 Keychain / ~/.gateway.env 读取, 绝不落明文(同 docs/19 §8 范式).
# 被测: 小可生产 gemini-proxy(23.226.135.149:4000 Vertex AI) gemini-3.1-flash-lite-preview
# judge: codex-api2 网关(cc-sub2) gpt-5.5
# 用法: bash run.sh [--limit N] [--concurrency M]
set -uo pipefail
cd "$(dirname "$0")"

export GEMINI_BASE_URL="http://23.226.135.149:4000/v1"
export GEMINI_API_KEY="$(security find-generic-password -s gemini-proxy-token -a gemini-proxy -w)"
export GEMINI_MODEL="gemini-3.1-flash-lite-preview"

set -a; source "$HOME/.gateway.env"; set +a
export JUDGE_BASE_URL="${CODEX_API_GATEWAY2_BASE_URL}"
export JUDGE_API_KEY="${CODEX_API_GATEWAY2_KEY}"
export JUDGE_MODEL="gpt-5.5"

python3 run_verify.py "$@"
