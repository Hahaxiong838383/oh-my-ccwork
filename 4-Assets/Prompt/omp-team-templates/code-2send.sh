#!/usr/bin/env bash
# A 双发写码实现: A1 grok-build CLI + A3 omp openai-codex/gpt-5.5
# 用法: bash code-2send.sh <repo-path> <prompt-file>
# 输出: /tmp/a-grok.md (A1 实现) + /tmp/a-gpt.md (A3 实现)
# cc 后续: diff 两版 + 挑优 / 合并 / 跑测试
# 适用: 高 stake (认证/支付/迁移/事故) 或 高难度 (>1000 行/跨子系统/算法核心) 写码

set -uo pipefail
REPO_PATH="${1:-$PWD}"
PROMPT_FILE="${2:-/tmp/p.md}"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "❌ prompt file 不存在: $PROMPT_FILE"
  echo "用法: bash code-2send.sh <repo-path> <prompt-file>"
  exit 1
fi
if [ ! -d "$REPO_PATH/.git" ]; then
  echo "⚠️ $REPO_PATH 不是 git 仓库,跳过 git 校验"
fi

export PATH="$HOME/.bun/bin:$PATH"

echo "===== A 双发写码 ====="
echo "[A1] grok-build CLI / 仓库=$REPO_PATH"
echo "[A3] omp openai-codex/gpt-5.5 / thinking=high"
echo "prompt: $PROMPT_FILE ($(wc -l <$PROMPT_FILE) 行)"
echo ""

START=$(date +%s)

# A1 grok-build CLI 直调
~/.grok/bin/grok --prompt-file "$PROMPT_FILE" \
  -m grok-build --effort high \
  --output-format plain --no-subagents \
  --cwd "$REPO_PATH" \
  > /tmp/a-grok.md 2>/tmp/a-grok.err &
GROK_PID=$!

# A3 omp openai-codex/gpt-5.5
omp -p --model openai-codex/gpt-5.5 --thinking high --auto-approve \
  --no-extensions --no-skills --no-rules \
  --append-system-prompt "$(cat "$PROMPT_FILE")" \
  "执行任务" \
  > /tmp/a-gpt.md 2>/tmp/a-gpt.err &
GPT_PID=$!

echo "两 lane 并发跑中 (PID grok=$GROK_PID, gpt=$GPT_PID)..."
wait $GROK_PID; GROK_RC=$?
wait $GPT_PID; GPT_RC=$?

END=$(date +%s)
echo ""
echo "===== 结果汇总 ====="
echo "A1 grok-build: RC=$GROK_RC, 输出 $(wc -l </tmp/a-grok.md 2>/dev/null || echo 0) 行"
echo "A3 omp gpt-5.5: RC=$GPT_RC, 输出 $(wc -l </tmp/a-gpt.md 2>/dev/null || echo 0) 行"
echo "总耗时 = $((END-START))s (并发 vs 串行省时 ≈1.5x)"
echo ""

# 失败时显示 stderr
if [ $GROK_RC -ne 0 ] || [ ! -s /tmp/a-grok.md ]; then
  echo "⚠️ A1 grok-build 失败/无正文:"
  tail -10 /tmp/a-grok.err
fi
if [ $GPT_RC -ne 0 ] || [ ! -s /tmp/a-gpt.md ]; then
  echo "⚠️ A3 omp gpt-5.5 失败:"
  tail -10 /tmp/a-gpt.err
fi

echo ""
echo "cc 下一步:"
echo "  1. 看 /tmp/a-grok.md vs /tmp/a-gpt.md"
echo "  2. 挑优 / 合并最佳方案"
echo "  3. 跑测试验证"
echo "  4. 若需进一步评审 → bash review-3send.sh /tmp/review.md"
