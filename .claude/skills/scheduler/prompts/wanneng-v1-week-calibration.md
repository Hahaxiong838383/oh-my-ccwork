# 万能公式 v1 试运行 1 周复盘 — Prompt

> 立项：2026-04-28（CLAUDE.md 万能公式 v1 压缩 + cc/codex 跨引擎规则共享）
> 复盘：2026-05-05 09:00（一周后）

---

## 你是 cc。按以下 4 项检查跑完，**不准改规则文件**，所有结论必附数据依据。

### 输入文件（按需读）

- `/Users/rayman.chen/mycc/CLAUDE.md` — 主规则文件（基线 165 行 / 8967 字符）
- `/Users/rayman.chen/mycc/CLAUDE.md.bak.20260428` — 压缩前备份（307 行 / 13086 字符 / md5 5bcf423ca5579b9c882a5c2f972a6a48）
- `/Users/rayman.chen/mycc/AGENTS.md` — codex 入口
- `/Users/rayman.chen/mycc/docs/rules/` — 规则子文件目录（基线 SCHEMA + 9 个）
- `/Users/rayman.chen/.claude/projects/-Users-rayman-chen-mycc/memory/feedback_codex_rule_id_preamble.md` — cc 端 preamble 规范
- `git log --since="7 days ago" --oneline mycc/CLAUDE.md mycc/AGENTS.md mycc/docs/rules/`

### 检查 1：主文件压缩比（≥40% 目标）

```bash
NEW=$(wc -l < /Users/rayman.chen/mycc/CLAUDE.md)
OLD=307
CHANGE=$(( (OLD - NEW) * 100 / OLD ))
echo "current=$NEW lines, baseline=307, compression=${CHANGE}%"
```

- 通过：当前行数在 [150, 200] 区间且压缩比 ≥40%
- 回归：当前 >220 行或压缩比 <30%（说明有人把详情塞回主文件）→ 报告添加位置

### 检查 2：codex 召回率实测（关键指标）

跑 2 个最小测试，看 codex 是否仍能命中 RULE-ID：

```bash
# Test A: 不带 preamble，仅靠 mycc/AGENTS.md 入口
cd /Users/rayman.chen/mycc
echo "评估给 mycc 装 lodash 的命令。不执行。输出命令 + 引用的 RULE-ID + 关键句。" \
  | codex exec --skip-git-repo-check - > /tmp/wn-cal-test-a.md 2>/dev/null

# Test B: 带 preamble + 换 P2 规则
cat <<'EOF' | codex exec --skip-git-repo-check - > /tmp/wn-cal-test-b.md 2>/dev/null
工作目录：/Users/rayman.chen/mycc
强制前置：动手前按下表判定命中，命中即 grep docs/rules/<RULE-ID>.md。grep 找不到 → 停下报告 cc。
关键词→RULE-ID:
- 改 ~/.claude/rules/ / skill / config → EVOLVE-AUTH

任务：评估改 ~/.claude/rules/workflow.md（git 规则 2026-06-13 并入处）加新 PR 模板，应该走什么流程。只评估。输出流程 + 引用的 RULE-ID + 关键句。
EOF
```

判定：
- Test A 输出含 `LOCAL-DEPS` 且命令不含 `-g` → PASS
- Test B 输出含 `EVOLVE-AUTH` 且提到红/黄/白标 → PASS
- 命中率 = 通过数 / 2

### 检查 3：分叉事故检查（无回归）

```bash
# 查 CLAUDE.md 是否被塞回 P2/P3 详情（按章节标题判断）
grep -E "^## (TOOL-PRIO|EVOLVE-AUTH|CONTEXT-BUDGET|LOCAL-DEPS|FEISHU-FALLBACK|MOBILE-MYCC|MULTI-DEVICE|CC-IDENTITY)" \
  /Users/rayman.chen/mycc/CLAUDE.md
# 期望：0 条（这些 RULE-ID 应只在索引行出现，不在主章节）

# 查 docs/rules/ 是否被复制粘贴到主文件（用某个独有关键句反查）
grep -c "所有外部依赖安装到项目根目录" /Users/rayman.chen/mycc/CLAUDE.md
# 期望：0（关键句应只在 docs/rules/LOCAL-DEPS.md 里）
```

- 通过：以上两项都 = 0
- 回归：>0 → 报告分叉位置（哪个 RULE-ID 被复制回主文件）

### 检查 4：新增规则成本

```bash
git -C /Users/rayman.chen/mycc log --since="7 days ago" --diff-filter=A --name-only docs/rules/ \
  | grep "docs/rules/.*\.md$" | grep -v SCHEMA | sort -u
```

- 0 个新增 → "试运行期无新增规则，无活动数据"
- ≥1 个新增 → 抽查最近 1 个新文件是否含 4 维优先级表（"P0|P1|P2|P3" + "权重"）+ Why 段
  - 含 → SCHEMA 被遵守
  - 不含 → SCHEMA 被绕过，需要补强或废弃

### 综合 verdict

| 通过项 | 结论 | 行动 |
|-------|------|------|
| 4/4 | ✅ 完全成功 | 推广到 `~/.claude/rules/` 和 mycc 其他记忆领域 |
| 3/4 | ⚠️ 基本成功 | 修复回归项后推广 |
| 2/4 | ⚠️ 有隐患 | 暂不推广，定位问题 |
| ≤1/4 | ❌ 失败 | 回滚：`cd mycc && git restore CLAUDE.md AGENTS.md && rm -rf docs/rules/` 或 `cp CLAUDE.md.bak.20260428 CLAUDE.md` |

---

## 输出三件套

1. **简报内容写入最终结构化结果**，禁止调用 `/tell-me`、`lark-im send`、`lark-cli` 或任何飞书发送工具。格式：

```
万能公式 v1 试运行 1 周复盘（2026-04-28→2026-05-05）

✅/⚠️/❌ 主文件压缩：当前 X 行 / 压缩比 Y%
✅/⚠️/❌ codex 召回：N/2
✅/⚠️/❌ 无分叉事故：发现 N 处
✅/⚠️/❌ 新增规则：N 条，N/M 走 SCHEMA

结论：[推广 / 修复后推广 / 暂不推广 / 回滚]
建议：[具体动作清单]
```

2. **写 memory**：`/Users/rayman.chen/.claude/projects/-Users-rayman-chen-mycc/memory/feedback_wanneng_v1_calibration.md`，含 4 项数据 + verdict + 时间戳，并更新 MEMORY.md 索引

3. **task-log 追加**：`/Users/rayman.chen/mycc/0-System/task-log.md` 一行：

```
| 2026-05-05 09:00 | rule | 万能公式 v1 一周复盘 — verdict X/4 / 主文件 Y 行 / codex N/2 / 分叉 N 处 / 新增 M 条；建议[推广|修复|暂缓|回滚] | cc | ✅ | — |
```

数据不足（无活动）时简报写"延后 2 周再校准"，并把下一次复盘日期 2026-05-19 09:00 加到 tasks.md。

---

## 约束

- 只读 + 测试 + 写记忆/简报，**不准改 CLAUDE.md / AGENTS.md / docs/rules/**
- 所有 verdict 必附数据（行数、命中数、分叉数）
- 时间戳用 `date "+%Y-%m-%d %H:%M"` 实际取，不编造
- 测试 A/B 失败也照常报告，不重试不掩盖
