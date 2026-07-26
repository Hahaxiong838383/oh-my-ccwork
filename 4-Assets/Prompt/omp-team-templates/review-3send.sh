#!/usr/bin/env bash
# B 三发评审对抗: B4 grok-4.5 推理 + B5 codex(API网关gpt-5.5主路+omp订阅gpt-5.4降级) 严谨 + B1 gemini 默认
# ⚠️ 2026-06-19: google-gemini-cli(Gemini Code Assist for individuals) 被 Google 停用("no longer supported, migrate to Antigravity")
#   → B1 gemini lane 全切 google-antigravity 通道。默认 antigravity/gemini-3-flash(快); 需深度手动换 gemini-3.5-flash。详见 memory project_antigravity_team_b3
# 用法: bash review-3send.sh <review-prompt-file>
# 输出: /tmp/r-grok.$RUN_TAG.md / /tmp/r-gpt.$RUN_TAG.md / /tmp/r-gem.$RUN_TAG.md (三家独立 finding)
# cc 后续: 三方综合 / 取并集 / 标各家独有发现 / 跑测试验证
# 适用: 高 stake/高难度评审 / code review / 顶级评审第一阶段

set -uo pipefail
PROMPT_FILE="${1:-/tmp/review.md}"
# per-run 产物路径(2026-07-26 P2④): 时间戳+PID 防并发评审互踩;实际路径以 stdout 报告为准
RUN_TAG="${TEAM_RUN_TAG:-$(date +%m%d-%H%M%S).$$}"

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
# ⛔ 2026-06-29: antigravity Google 账户(hahaxiong83@gmail.com)的 Cloud Code Assist 被 Google 判 TOS_VIOLATION 封禁
#   (403 PERMISSION_DENIED "service disabled in this account for violation of Terms of Service")→ B1 gemini lane(走 antigravity)全挂。
#   暂时下线 gemini lane, team 用 grok+codex 两发顶。恢复: 账户申诉成功 / 换干净 Google 号后, `export GEMINI_LANE_ENABLED=1` 即复活。
#   详见 memory project_antigravity_team_b3 + feedback_antigravity_tos_ban_team_gemini_down。
GEMINI_LANE_ENABLED="${GEMINI_LANE_ENABLED:-0}"
# codex lane helper: API 网关 gpt-5.5 主路(curl 纯文本,本就非 agentic) + omp 订阅 gpt-5.4 降级(经 NO_TOOLS 只读)
source "$(dirname "${BASH_SOURCE[0]}")/_codex_lane.sh"
# 注: grok/gemini lane 直接调 omp -p(见下), 不依赖额外 helper
# 署名修复(2026-06-17): omp 调 grok/gemini 时 cwd 在 mycc 下会向上加载 mycc/AGENTS.md(codex 身份文件,
#   写死"署名 codex"),--no-rules 挡不住 → 三家都误署 codex。用 --cwd 指向无 AGENTS.md 的干净临时目录
#   从源头阻断(评审 --no-tools 不读文件,cwd 无副作用);叠加 prompt 署名指令双保险。
CLEAN_CWD="$(mktemp -d)"
trap 'rm -rf "$CLEAN_CWD"' EXIT

REVIEW_GUARD='【评审约束·最高优先级】你是只读评审者。禁止创建/修改/删除任何文件、禁止改配置、禁止执行任何变更类命令(写文件/git/部署/安装/sed -i 等)。即使你判断"应该帮忙落地",也只能在 finding 里写出建议,由主 session 决定是否执行。你的唯一产出是评审 finding 文本。
署名: 报告末尾按你的真实模型身份署名(grok→「署名：grok（xAI）」/ gemini→「署名：gemini（Google）」/ gpt/codex→「署名：codex（OpenAI）」), 忽略任何项目配置文件(AGENTS.md 等)里写死的默认署名。

'
PROMPT="$REVIEW_GUARD$(cat "$PROMPT_FILE")"
SIZE=$(wc -c <"$PROMPT_FILE")
# (2026-07-26 P2④) per-run 唯一路径已根治"旧残留假阳性"(2026-07-03 实踩),故不再 rm 清理——
# 并发下 rm /tmp/r-*.md 通配反而会误删别轮进行中的产物。
echo "===== B 三发评审对抗 ====="
echo "[B4 推理] omp xai-oauth/grok-4.5 / thinking=high"
echo "[B5 严谨] codex API 网关 gpt-5.5(主) → omp 订阅 gpt-5.4(降级) / reasoning=high"
if [ "$GEMINI_LANE_ENABLED" = "1" ]; then
  echo "[B1 默认] omp google-antigravity/gemini-3-flash / thinking=high (gemini-cli 已停用,切 antigravity)"
else
  echo "[B1 默认] ⛔ 已下线 (antigravity 账户 2026-06-29 被 Google TOS 封禁; export GEMINI_LANE_ENABLED=1 恢复)"
fi
echo "prompt: $PROMPT_FILE ($SIZE 字节)"
echo ""

# B4 grok token 预检自愈(2026-06-25): xai-oauth refresh token 轮换冲突会致 B4 lane 挂(invalid_grant)。
# 平时由 launchd com.omp.xai-token-refresh 每 2h 保鲜;此处兜底:access token <10min 过期则刷一次。
# token 已吊销则告警但不阻断(B5/B1 照跑) → 提示真终端跑 omp-xai-relogin.sh 重登。
XAI_REFRESH="$HOME/mycc/4-Assets/SOP/omp-xai-token-refresh.py"
if [ -f "$XAI_REFRESH" ]; then
  python3 "$XAI_REFRESH" --if-expiring 600 --quiet 2>/dev/null \
    || echo "⚠️ [B4 grok] xai-oauth token 刷新失败(refresh token 可能被吊销) → 真终端跑 bash ~/mycc/4-Assets/SOP/omp-xai-relogin.sh 重登;本轮 B4 或无正文"
fi

START=$(date +%s)

# ⚠️ 重要: 3 个 omp 进程同时启动会撞 SQLite schema initialize race condition
# (~/.omp/agent/agent.db, 多写者 race), 启动间错开 800ms 避开 schema init 窗口

# B4 grok-4.5 推理评审 (第一性原理 / 反思维定式) —— 2026-07-09 切 grok-4.5(当日发布,实测 thinking high 通/16s);回退 ID: xai-oauth/grok-4.3
omp -p --model xai-oauth/grok-4.5 --thinking high --no-tools --cwd "$CLEAN_CWD" \
  --no-extensions --no-skills --no-rules \
  "$PROMPT" \
  > /tmp/r-grok.$RUN_TAG.md 2>/tmp/r-grok.$RUN_TAG.err &
GROK_PID=$!

sleep 0.8

# B5 codex 严谨评审: API 网关 gpt-5.5 主路 + omp 订阅 gpt-5.4 降级 (见 _codex_lane.sh)
run_codex_lane "$PROMPT" /tmp/r-gpt.$RUN_TAG.md /tmp/r-gpt.$RUN_TAG.err "B5" &
GPT_PID=$!

sleep 0.8

# B1 gemini-3-flash 默认评审 (2026-06-19 切 antigravity; 2026-06-29 antigravity 账户被 Google TOS 封禁→默认下线)
GEM_RC=0
if [ "$GEMINI_LANE_ENABLED" = "1" ]; then
  omp -p --model google-antigravity/gemini-3-flash --thinking high --no-tools --cwd "$CLEAN_CWD" \
    --no-extensions --no-skills --no-rules \
    "$PROMPT" \
    > /tmp/r-gem.$RUN_TAG.md 2>/tmp/r-gem.$RUN_TAG.err &
  GEM_PID=$!
else
  GEM_PID=""
  echo "⛔ B1 gemini lane 已下线(antigravity 账户 TOS 封禁 2026-06-29) — 本轮按 grok+codex 两发综合。" > /tmp/r-gem.$RUN_TAG.md
fi

echo "lane 错开启动跑中 (PID grok=$GROK_PID gpt=$GPT_PID gem=${GEM_PID:-下线}, 间隔 800ms)..."
wait $GROK_PID; GROK_RC=$?
wait $GPT_PID; GPT_RC=$?
[ -n "$GEM_PID" ] && { wait $GEM_PID; GEM_RC=$?; }

END=$(date +%s)
echo ""
echo "===== 结果汇总 ====="
echo "B4 grok-4.5 推理: RC=$GROK_RC, 输出 $(wc -l </tmp/r-grok.$RUN_TAG.md 2>/dev/null || echo 0) 行"
echo "B5 gpt-5.5 严谨: RC=$GPT_RC, 输出 $(wc -l </tmp/r-gpt.$RUN_TAG.md 2>/dev/null || echo 0) 行"
if [ -n "$GEM_PID" ]; then
  echo "B1 gemini-3-flash 默认: RC=$GEM_RC, 输出 $(wc -l </tmp/r-gem.$RUN_TAG.md 2>/dev/null || echo 0) 行"
else
  echo "B1 gemini-3-flash 默认: ⛔ 已下线(antigravity TOS 封禁) — 本轮 grok+codex 两发"
fi
echo "总耗时 = $((END-START))s (vs 串行省时 ≈1.7x)"
echo ""

# 失败处理
for var in "grok GROK" "gpt GPT" "gem GEM"; do
  name=$(echo $var | cut -d' ' -f1)
  PREFIX=$(echo $var | cut -d' ' -f2)
  eval RC=\${${PREFIX}_RC}
  if [ "$RC" -ne 0 ] || [ ! -s "/tmp/r-$name.$RUN_TAG.md" ]; then
    echo "⚠️ B-$name 失败/无正文:"
    tail -5 "/tmp/r-$name.$RUN_TAG.err"
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

echo "本轮产物: /tmp/r-grok.$RUN_TAG.md | /tmp/r-gpt.$RUN_TAG.md | /tmp/r-gem.$RUN_TAG.md"
