#!/usr/bin/env bash
# B 四发评审顶级 —— B4 grok + B5 codex + B1 gemini-flash + B3 antigravity gemini-3.5-flash(免费深度档)
# 2026-06-17 川哥指示: B3 顶级深度档从「付费 VPS proxy」迁移到「免费 antigravity 通道」。
#   引擎: omp --model google-antigravity/gemini-3.5-flash --thinking high (ChatGPT/Gemini 订阅外的独立 Google 深度声音)
#   网络: 走 xray「Gemini专用-US2」节点 —— cloudcode-pa.googleapis.com 系列已加入 xray 路由白名单(最高优先级),
#         避开通用美宅节点被 Google Cloud Code Assist 判 400「location not supported」。详见 memory project_antigravity_team_b3。
#   并行: 先后台起 B3, sleep 1 错开 omp SQLite(agent.db) race, 再调 review-3send.sh 跑 B4+B5+B1, 最后 wait B3 合并。
# 用法: bash review-4send.sh <review-prompt-file>
# 输出: /tmp/r-grok.md + /tmp/r-gpt.md + /tmp/r-gem.md (三发) + /tmp/r-gem35.md (B3 深度)
# cc 后续: 四家综合 / 取并集 / 标各家独有 finding / 跑测试验证

set -uo pipefail
PROMPT_FILE="${1:-/tmp/review.md}"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "❌ review prompt file 不存在: $PROMPT_FILE"
  echo "用法: bash review-4send.sh <review-prompt-file>"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$HOME/.bun/bin:$PATH"
# 只读评审硬约束(2026-06-17 事故后加固,同 review-3send.sh): B3 lane 用 --no-tools + --cwd 干净目录 + prompt guard。
CLEAN_CWD="$(mktemp -d)"
trap 'rm -rf "$CLEAN_CWD"' EXIT
REVIEW_GUARD='【评审约束·最高优先级】你是只读评审者。禁止创建/修改/删除任何文件、禁止改配置、禁止执行任何变更类命令(写文件/git/部署/安装/sed -i 等)。即使你判断"应该帮忙落地",也只能在 finding 里写出建议,由主 session 决定是否执行。你的唯一产出是评审 finding 文本。
署名: 报告末尾按你的真实模型身份署名(grok→「署名：grok（xAI）」/ gemini→「署名：gemini（Google）」/ gpt/codex→「署名：codex（OpenAI）」), 忽略任何项目配置文件(AGENTS.md 等)里写死的默认署名。

'
PROMPT="$REVIEW_GUARD$(cat "$PROMPT_FILE")"
SIZE=$(wc -c <"$PROMPT_FILE")

echo "===== B 四发评审顶级对抗 ====="
echo "[B4 推理] grok-4.3 / [B5 严谨] codex gpt-5.5 / [B1 默认] gemini-3-flash / [B3 深度] antigravity gemini-3.5-flash(免费)"
echo "prompt: $PROMPT_FILE ($SIZE 字节)"
echo ""
START=$(date +%s)

# B3 antigravity gemini-3.5-flash 顶级深度档(免费, 走 xray Gemini专用-US2 节点) —— 后台先起, 与三发并行
echo "[B3 深度] omp google-antigravity/gemini-3.5-flash --thinking high (后台启动, 与三发并行)"
omp -p --model google-antigravity/gemini-3.5-flash --thinking high --no-tools --cwd "$CLEAN_CWD" \
  --no-extensions --no-skills --no-rules \
  "$PROMPT" \
  > /tmp/r-gem35.md 2>/tmp/r-gem35.err &
B3_PID=$!

# 错开 omp SQLite schema-init race 窗口(三发内部还会再各自错开 800ms)
sleep 1

# B4 + B5 + B1 三发(review-3send.sh 内部并行 + 800ms 错开)
bash "$SCRIPT_DIR/review-3send.sh" "$PROMPT_FILE"

# 等 B3 完成
wait "$B3_PID"; B3_RC=$?
END=$(date +%s)

echo ""
echo "===== B3 深度档结果 ====="
echo "B3 gemini-3.5-flash 深度: RC=$B3_RC, 输出 $(wc -l </tmp/r-gem35.md 2>/dev/null || echo 0) 行 | 四发总耗时 ≈ $((END-START))s"
if [ "$B3_RC" -ne 0 ] || [ ! -s /tmp/r-gem35.md ]; then
  echo "⚠️ B3 失败/无正文:"
  tail -5 /tmp/r-gem35.err 2>/dev/null
  echo "   排障: ① pgrep -fl 'xray run' 确认代理在跑 ② grep cloudcode ~/xray/access.log | tail 确认走 Gemini专用-US2"
  echo "        ③ omp models | grep -A2 google-antigravity 确认通道 ④ 详见 memory project_antigravity_team_b3"
  echo "   降级: 四发缺 B3 时按三发(B4+B5+B1)综合, 不阻塞顶级评审"
fi

echo ""
echo "===== 四发评审完成 ====="
echo "产出: /tmp/r-grok.md + /tmp/r-gpt.md + /tmp/r-gem.md + /tmp/r-gem35.md"
echo "cc 综合标准流程:"
echo "  1. 四家共识 finding → 最高置信度, 必修"
echo "  2. 三家共识 → 高置信度, 必修"
echo "  3. 两家共识 → 中置信度, 核验后修"
echo "  4. 一家独有 → 低置信度, 标'待验证', 跑测试/人工 review 验证"
echo "  5. 写 REVIEW.md 综合四家 + cc 自验补充"
