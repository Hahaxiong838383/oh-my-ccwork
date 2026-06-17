#!/usr/bin/env bash
# 路 C 高质量写码: codex 出 Search/Replace 块 → 确定性应用器(apply-blocks.py)落盘 → 报告 → cc 接手验证。
# 设计依据: 2026-06-17 team 三发评审(grok/codex/gemini)收敛——强脑(codex)出块 + 无失真的手(脚本)落盘 + 独立判官(测试)。
# 用法: bash code-patch.sh <repo-path> <spec-file>
#   spec-file: cc 准备的极简 spec(目标/非目标/验收点) + 相关代码上下文(目标文件现有片段,供 codex 出准 SEARCH 段)。
# 输出: /tmp/codex-blocks.txt(原始块) + apply 报告(JSON) + git diff。
# 分轨: 仅高风险/跨≥3文件/核心路径用本流程; 小改/文档用 cc 或 grok 直写 + 最小构建门。
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${1:?用法: code-patch.sh <repo-path> <spec-file>}"
SPEC="${2:?缺 spec 文件}"
[ -f "$SPEC" ] || { echo "❌ spec 文件不存在: $SPEC"; exit 1; }
[ -d "$REPO/.git" ] || echo "⚠️ $REPO 不是 git 仓库,跳过工作区/base 检查(建议在 git repo 内用,便于核验与回滚)"

export PATH="$HOME/.bun/bin:$PATH"
export CODEX_LANE_NO_TOOLS=1   # codex 只出块文本,绝不碰文件(落盘由 apply-blocks.py 确定性完成)
source "$SCRIPT_DIR/_codex_lane.sh"

# 前置: 工作区干净检查 + 记录 base commit(便于核验/回滚)
BASE=""
if [ -d "$REPO/.git" ]; then
  BASE=$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo "")
  if [ -n "$(git -C "$REPO" status --porcelain 2>/dev/null)" ]; then
    echo "⚠️ 工作区有未提交改动(base=$BASE)。建议先 commit/stash 再跑,以便 git diff 干净对照本次 patch。"
  fi
fi

# codex prompt: spec + 严格块格式约束(第二道防线: 即便 codex 想多嘴,格式约束逼它只出块)
FORMAT_RULES=$(cat <<'RULES'

# ============ 输出格式（最高优先级，违反则无法落盘）============
你只输出 Search/Replace 块，禁止任何散文解释、禁止 markdown 代码围栏。每个改动一个块：

FILE: <相对仓库根的路径>
<<<<<<< SEARCH
<目标文件中将被替换的原文精确片段>
=======
<替换后的新内容>
>>>>>>> REPLACE

硬规则：
1. SEARCH 段必须是目标文件中【逐字符精确存在】的片段(含缩进/空格),且带足够上下文使其在文件中【唯一】(匹配多处会被判失败)。
2. 只输出【改动片段】,禁止重贴整个文件(大文件会超时)。
3. 新建文件: SEARCH 段留空(FILE 行后紧跟起始标记,再分隔标记,再写新内容)。
4. 同一文件多处改动 = 多个独立块(各自以 FILE: 开头)。
5. 不确定原文精确内容时,宁可缩小改动范围,不要猜 SEARCH 段。
RULES
)
PROMPT="$(cat "$SPEC")$FORMAT_RULES"

echo "===== 路 C: codex 出 Search/Replace 块 (repo=$REPO base=$BASE) ====="
run_codex_lane "$PROMPT" /tmp/codex-blocks.raw /tmp/codex-blocks.err "PATCH"
RC=$?
if [ "$RC" -ne 0 ] || [ ! -s /tmp/codex-blocks.raw ]; then
  echo "❌ codex 出块失败 (RC=$RC):"; tail -5 /tmp/codex-blocks.err 2>/dev/null; exit 1
fi

# 清洗: 剥可能的 markdown 围栏行
grep -v '^```' /tmp/codex-blocks.raw > /tmp/codex-blocks.txt

echo "===== 确定性应用块 (apply-blocks.py) ====="
APPLY_OUT=$(python3 "$SCRIPT_DIR/apply-blocks.py" /tmp/codex-blocks.txt "$REPO")
APPLY_RC=$?
echo "$APPLY_OUT"

if [ "$APPLY_RC" -ne 0 ]; then
  echo ""
  echo "⚠️ 有块未能干净应用(已零写入,repo 未被改动)。"
  echo "   cc 下一步: 把上面 failed 列表 + 对应文件现状拼成回传包,让 codex 基于精确原文重出块(禁止 cc 手改逻辑)。"
  exit 1
fi

echo ""
echo "===== git diff (本次落盘改动) ====="
[ -d "$REPO/.git" ] && git -C "$REPO" --no-pager diff --stat

echo ""
echo "cc 下一步(路 C 判官环节):"
echo "  1. 核验 git diff 符合 spec 验收点(无多改/漏改)"
echo "  2. 跑测试/验收门 + lint + 构建"
echo "  3. RED → 把失败回传 codex 重出块(熔断≤2 次); 超限降级'cc 接手+外部 diff 审',标签改为非路 C"
echo "  4. 高风险(认证/支付/迁移/不可逆) → 另一引擎(grok/gemini)审实际落盘 diff"
