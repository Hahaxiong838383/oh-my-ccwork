#!/usr/bin/env bash
# B 三发评审对抗: B4 grok-4.3 推理 + B5 codex(API网关gpt-5.5主路+omp订阅gpt-5.4降级) 严谨 + B1 gemini-3-flash 默认(川哥定: gemini 默认先 flash, 需长综合深度手动换 B2 gemini-3.1-pro-preview)
# 用法: bash review-3send.sh <review-prompt-file>
# 输出: /tmp/r-grok.md / /tmp/r-gpt.md / /tmp/r-gem.md (三家独立 finding)
# cc 后续: 三方综合 / 取并集 / 标各家独有发现 / 跑测试验证
# 适用: 高 stake/高难度评审 / code review / 顶级评审第一阶段

set -uo pipefail
PROMPT_FILE="${1:-/tmp/review.md}"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "❌ review prompt file 不存在: $PROMPT_FILE"
  echo "用法: bash review-3send.sh <review-prompt-file>"
  echo ""
  echo "建议 prompt 结构:"
  cat <<'EXAMPLE'
# 评审任务
[评审目标 / 验收标准]

# 内容
[diff / 代码 / 设计文档]

# 评审角度
- 正确性: 业务逻辑 / 边界用例 / 错误处理
- 安全: 凭据 / SQL injection / XSS / 权限
- 性能: 时间复杂度 / 内存 / 并发安全
- 风格: 可读性 / 命名 / 重复代码
EXAMPLE
  exit 1
fi

export PATH="$HOME/.bun/bin:$PATH"
# 只读评审硬约束(2026-06-17 事故后加固): 评审引擎绝不能改文件/配置。
#   第一道防线 = CLI 沙箱: omp lane 用 --no-tools(禁所有内置工具,纯文本推理); codex 兜底 omp 经此信号同样 --no-tools。
#   第二道防线 = prompt guard(见 REVIEW_GUARD): 显式告知引擎只做评审。
# 起因: gemini lane 曾带 --auto-approve 自动批准写操作,擅改了用户生产配置(~/.claude/settings.json)。
export CODEX_LANE_NO_TOOLS=1
# codex lane helper: API 网关 gpt-5.5 主路(curl 纯文本,本就非 agentic) + omp 订阅 gpt-5.4 降级(经 NO_TOOLS 只读)
source "$(dirname "${BASH_SOURCE[0]}")/_codex_lane.sh"
# 注: grok/gemini lane 直接调 omp -p(见下), 不依赖额外 helper

REVIEW_GUARD='【评审约束·最高优先级】你是只读评审者。禁止创建/修改/删除任何文件、禁止改配置、禁止执行任何变更类命令(写文件/git/部署/安装/sed -i 等)。即使你判断"应该帮忙落地",也只能在 finding 里写出建议,由主 session 决定是否执行。你的唯一产出是评审 finding 文本。

'
PROMPT="$REVIEW_GUARD$(cat "$PROMPT_FILE")"
SIZE=$(wc -c <"$PROMPT_FILE")
echo "===== B 三发评审对抗 ====="
echo "[B4 推理] omp xai-oauth/grok-4.3 / thinking=high"
echo "[B5 严谨] codex API 网关 gpt-5.5(主) → omp 订阅 gpt-5.4(降级) / reasoning=high"
echo "[B1 默认] omp google-gemini-cli/gemini-3-flash-preview / thinking=high"
echo "prompt: $PROMPT_FILE ($SIZE 字节)"
echo ""

START=$(date +%s)

# ⚠️ 重要: 3 个 omp 进程同时启动会撞 SQLite schema initialize race condition
# (~/.omp/agent/agent.db, 多写者 race), 启动间错开 800ms 避开 schema init 窗口

# B4 grok-4.3 推理评审 (第一性原理 / 反思维定式)
omp -p --model xai-oauth/grok-4.3 --thinking high --no-tools \
  --no-extensions --no-skills --no-rules \
  "$PROMPT" \
  > /tmp/r-grok.md 2>/tmp/r-grok.err &
GROK_PID=$!

sleep 0.8

# B5 codex 严谨评审: API 网关 gpt-5.5 主路 + omp 订阅 gpt-5.4 降级 (见 _codex_lane.sh)
run_codex_lane "$PROMPT" /tmp/r-gpt.md /tmp/r-gpt.err "B5" &
GPT_PID=$!

sleep 0.8

# B1 gemini-3-flash 默认评审 (川哥定默认: 快/稳; 需长综合深度手动换 gemini-3.1-pro-preview)
omp -p --model google-gemini-cli/gemini-3-flash-preview --thinking high --no-tools \
  --no-extensions --no-skills --no-rules \
  "$PROMPT" \
  > /tmp/r-gem.md 2>/tmp/r-gem.err &
GEM_PID=$!

echo "三 lane 错开启动跑中 (PID grok=$GROK_PID gpt=$GPT_PID gem=$GEM_PID, 间隔 800ms)..."
wait $GROK_PID; GROK_RC=$?
wait $GPT_PID; GPT_RC=$?
wait $GEM_PID; GEM_RC=$?

END=$(date +%s)
echo ""
echo "===== 结果汇总 ====="
echo "B4 grok-4.3 推理: RC=$GROK_RC, 输出 $(wc -l </tmp/r-grok.md 2>/dev/null || echo 0) 行"
echo "B5 gpt-5.5 严谨: RC=$GPT_RC, 输出 $(wc -l </tmp/r-gpt.md 2>/dev/null || echo 0) 行"
echo "B1 gemini-3-flash 默认: RC=$GEM_RC, 输出 $(wc -l </tmp/r-gem.md 2>/dev/null || echo 0) 行"
echo "总耗时 = $((END-START))s (vs 串行省时 ≈1.7x)"
echo ""

# 失败处理
for var in "grok GROK" "gpt GPT" "gem GEM"; do
  name=$(echo $var | cut -d' ' -f1)
  PREFIX=$(echo $var | cut -d' ' -f2)
  eval RC=\${${PREFIX}_RC}
  if [ "$RC" -ne 0 ] || [ ! -s "/tmp/r-$name.md" ]; then
    echo "⚠️ B-$name 失败/无正文:"
    tail -5 "/tmp/r-$name.err"
  fi
done

echo ""
echo "cc 下一步 (三方综合标准流程):"
echo "  1. 三家共识 finding → 高置信度,必修"
echo "  2. 两家共识 finding → 中置信度,核验后修"
echo "  3. 一家独有 finding → 低置信度,标'待验证',跑测试或人工 review 验证"
echo "  4. 写 REVIEW.md 综合各家观点 + cc 自验补充"
echo ""
echo "若需升级到顶级四发评审 (+ B3 antigravity gemini-3.5-flash 免费深度档):"
echo "  bash review-4send.sh $PROMPT_FILE"
