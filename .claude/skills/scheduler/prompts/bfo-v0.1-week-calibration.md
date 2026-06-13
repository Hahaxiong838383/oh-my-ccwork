# BFO 实体锚定 V0.1 一周校准任务

> 由 mycc scheduler 在 2026-05-05 18:00 一次性触发。
> V0.1 上线日：2026-04-28。
> 此 prompt 由 cc 在 2026-04-28 18:50 起草。

你是 mycc 的 cc，被 mycc scheduler 在本地触发执行 BFO 实体锚定 V0.1 上线一周后的阈值校准任务。

你**跑在本地**，可以访问 `~/.claude/`、`~/mycc/`、`lark-cli` 等所有本地资源。

## 上下文（读完再动手）

V0.1 规则核心写在两处，必须先读：
- `~/.claude/docs/no-guessing-full.md` § 实体锚定（完整版含违规案例；常驻核心已于 2026-06-13 抽到 rules/behavior.md）
- `~/.claude/skills/verification-before-completion/SKILL.md` § Entity & Event Anchor Check（按需 skill 版本）

V0.1 设计起源 + 试跑结果记录：
- `~/.claude/projects/-Users-rayman-chen-mycc/memory/project_bfo_anchoring.md`
- `~/.claude/projects/-Users-rayman-chen-mycc/memory/feedback_anti_hallucination_design.md`

## 数据源（按优先级读）

1. **`~/.claude/docs/no-guessing-full.md`** — 重点看「已发生违规案例」段，2026-04-28 之后是否新增条目（=V0.1 没拦住的真实幻觉，最强信号）
2. **`~/mycc/0-System/task-log.md`** — 看 `friction_skill` 列 2026-04-28 之后是否含「BFO」「锚定」「自检」「实体推断」「事件转述」「脑补」等关键词
3. **`~/.claude/projects/-Users-rayman-chen-mycc/memory/`** — 跑：
   ```bash
   cd ~/.claude/projects/-Users-rayman-chen-mycc/memory
   grep -l "BFO\|锚定\|实体锚\|anchor\|self-check\|自检" *.md
   ```
   找出所有相关 memory，重点读：
   - `project_bfo_anchoring.md`（V0.1 规则核心 + 试跑结果，看是否有 V0.2 级更新）
   - `feedback_anti_hallucination_design.md`（设计原则）
   - 一周内新增的 `feedback_bfo_*` 或 `feedback_*` 涉及自检的条目
4. **git 历史**：
   ```bash
   cd ~/mycc
   git log --since="2026-04-28" -p -- 0-System/task-log.md .claude/projects/-Users-rayman-chen-mycc/memory/
   ```
   看具体改动。
5. **`~/.claude/skills/verification-before-completion/SKILL.md`** — 看是否有 V0.2 级修改的痕迹（如老板在中途手动改过）。

## 校准 4 维度

| 参数 | 当前值 | 信号源 | 决策规则 |
|------|------|--------|---------|
| 具名资源·推断扣分 | −0.3 | no-guessing 违规案例 + task-log friction「实体推断脑补」 | 新增违规 → 收紧到 −0.4；老板抱怨过严 → 放宽到 −0.2；零信号 → 保持 |
| 已发生事件·转述扣分 | −0.2 | friction「事件转述当本轮观察」 | 同上逻辑 |
| 短路滥用 | `[自检 OK] 仅逻辑推断` | 无埋点，看 memory/feedback 是否有相关抱怨 | 有抱怨 → 标注待 V0.2 收紧；无 → 保持 |
| load-bearing 边界 | — | memory 是否新增 feedback 涉及「这是不是 load-bearing」歧义 | 有歧义 → 建议补例子集；无 → 保持 |

## 输出（三件套）

### 1. 飞书简报

用 `lark-cli` 推到 cc 群（chat_id 自查 `~/.claude/skills/lark-im/SKILL.md` 或调用 `/tell-me` skill），≤200 字，结构：

```
📊 BFO V0.1 一周校准

样本量：
- no-guessing 违规新增 X 条
- task-log 自检相关摩擦 Y 条
- memory 自检反馈 Z 条

4 维度：
- 具名资源扣分 −0.3 → [保持/收紧 −0.4/放宽 −0.2]
- 事件转述扣分 −0.2 → [保持/...]
- 短路滥用 → [保持/收紧定义]
- load-bearing 边界 → [保持/补例子]

总建议：[V0.1 保持 / 升 V0.2 含 N 项调整]
依据：（一句话）
```

### 2. feedback memory

写到 `~/.claude/projects/-Users-rayman-chen-mycc/memory/feedback_bfo_v0.1_calibration.md`，frontmatter:

```markdown
---
name: BFO V0.1 一周校准结果（2026-05-05）
description: V0.1 上线一周后的阈值校准数据 + 调整决策
type: feedback
---
```

正文必含：
- **数据源汇总**：具体读到了什么（附 grep/git log 输出节选）
- **4 维度评分**：每维度的信号 + 决策 + 依据引用
- **调整决策**：保持 V0.1 / 建议升 V0.2 含哪几项调整
- **数据缺口**：哪些维度信号不足，是否需要加埋点
- **下次校准建议**：推荐何时再做下一轮（如 2 周后、1 个月后）

同步到 mycc 仓内镜像（让远程多设备能看到）：

```bash
cp ~/.claude/projects/-Users-rayman-chen-mycc/memory/feedback_bfo_v0.1_calibration.md \
   ~/mycc/.claude/projects/-Users-rayman-chen-mycc/memory/
```

并在两边的 `MEMORY.md` 索引末尾追加一行（在 Feedback section）：

```
- [feedback_bfo_v0.1_calibration.md](feedback_bfo_v0.1_calibration.md) — BFO V0.1 一周校准（2026-05-05）：[决策摘要]
```

### 3. task-log + git push

在 `~/mycc/0-System/task-log.md` 末尾追加：

```
| 2026-05-05 HH:MM | rule | BFO V0.1 一周校准 — [决策摘要≤30字] | cc (scheduler) | ✅ | — |
```

然后 commit + push：

```bash
cd ~/mycc
git add 0-System/task-log.md \
  .claude/projects/-Users-rayman-chen-mycc/memory/feedback_bfo_v0.1_calibration.md \
  .claude/projects/-Users-rayman-chen-mycc/memory/MEMORY.md
git commit -m "rule: BFO V0.1 一周校准报告"
git push origin main
```

## 数据不足时（一周内 5 个数据源全部零相关）

- 飞书简报输出「样本不足，延后 2 周再校准」+ 简短说明缺什么数据
- 不写 memory，但更新 task-log（说明本轮无数据 + 下次校准计划日期 2026-05-19）
- 飞书提示老板：是否手动触发更密的使用观察 / 是否需要给 cc 加自检触发计数埋点

## 约束（重要，不可违反）

- **不得修改 `~/.claude/docs/no-guessing-full.md` 或 `~/.claude/skills/verification-before-completion/SKILL.md`**——校准只输出建议到 memory + 飞书。任何阈值修改必须等老板下次手动批准
- 任何"具体阈值改成 X"的建议必须附数据依据（grep 命中数 / git diff 行数 / memory 摘录），禁止凭直觉
- 飞书推送如遇限速 429，按 `feedback_lark_cli_keychain_ssh` 走 open-feishu-mcp `send_message` 备用通道
- **自检字段必带（按 V0.1 规则演练）**：在向飞书推送 / 写 memory / push 仓 三个对外操作前各跑一次 `[自检]` 自报，作为 V0.1 dogfood 数据——这次校准本身也是 V0.1 的真实使用样本

## 完成后

把本次执行的所有 `[自检]` 自报内容、命中规则、是否拦截，附在 feedback memory 末尾的「附录·V0.1 dogfood 样本」section 里——这是给未来 V0.2 校准的真实使用日志。
