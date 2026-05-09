---
name: skill-review
description: Skill 质量评审 — 8 维 Rubric 量化打分 + 子 Agent 独立评分 + with-skill vs baseline 实测对比。用于评估 .claude/skills/ 下任意 skill 的结构质量和实际效果。触发词："/skill-review"、"skill评分"、"skill质量"、"评估这个skill"、"这个skill写得怎么样"、"skill打分"。
layer: 分析层
authorization: B区（评分自动跑，改动需确认）
output_levels: L2（评分卡 + 短板 + 建议）
---

# skill-review — Skill 质量评审

> 借鉴 darwin-skill（GitHub: alchaincyf/darwin-skill）的 8 维 Rubric，吸收其评估框架，不引入全套自优化循环。
> 定位：**只评审不自动改**。改动走 `skill-creator` 或人工 edit。

---

## 核心约束

1. **只读取 + 打分 + 给建议**。不直接修改 SKILL.md。
2. **评分必须独立**。效果维度用子 Agent 跑 baseline 对比，避免"改完自己评"偏差。
3. **不引入新依赖**。纯 markdown + 现有 Task 工具。
4. **尊重中文为主**。评分说明、建议输出全部用中文。

---

## 8 维 Rubric（总分 100）

### 结构维度（60 分）— 静态分析，主 Agent 直读即可打分

| # | 维度 | 权重 | 评分标准（1-10） |
|---|------|------|----------------|
| 1 | **Frontmatter 质量** | 8 | `name` 规范、`description` 包含「做什么 + 何时用 + 触发词」、≤1024 字符；中英文触发词齐全加分 |
| 2 | **工作流清晰度** | 15 | 步骤有序号、每步输入/输出明确；有 Phase/Step 分层加分；散文式无序扣分 |
| 3 | **边界条件覆盖** | 10 | 有 fallback、异常处理、失败恢复；覆盖常见错误场景 |
| 4 | **检查点设计** | 7 | 关键决策前暂停等用户确认；防止自主失控；纯自动化但未声明风险扣分 |
| 5 | **指令具体性** | 15 | 不用模糊动词（"处理"、"优化"）；给具体参数、路径、示例；可直接执行 |
| 6 | **资源整合度** | 5 | references/scripts/assets 路径可达；外部依赖已声明；硬编码路径扣分 |

### 效果维度（40 分）— 必须实测或至少干跑

| # | 维度 | 权重 | 评分标准 |
|---|------|------|---------|
| 7 | **整体架构** | 15 | 分层清晰、不冗余不遗漏；与 mycc 生态（CLAUDE.md、memory、trajectories）一致；中文风格一致 |
| 8 | **实测表现** | 25 | 跑 2-3 个测试 prompt，对比 with-skill vs baseline（不带 skill）的输出质量 |

**加权总分 = Σ(维度分 × 权重) / 10**，满分 100。

---

## 评分等级参考

| 总分 | 等级 | 含义 |
|------|------|-----|
| 90-100 | A | 精品 skill，可作为模板参考 |
| 80-89 | B | 合格，小改可优化 |
| 70-79 | C | 可用但有短板，建议重点维度改进 |
| 60-69 | D | 勉强可用，结构或效果有明显问题 |
| <60 | F | 建议重写或下线 |

---

## 执行流程

### Phase 0: 确定评审范围

用户触发时，`$ARGUMENTS` 可以是：
- `<skill-name>`：只评一个
- `--all`：扫描 `.claude/skills/*/SKILL.md` 全部（慎用，70+ 个）
- `--dir <path>`：指定目录
- `--dry-run`：跳过子 Agent 实测，只做干跑评分
- `--with-baseline`：启用子 Agent 跑 with-skill vs baseline 对比（黄标模式，成本高）

**默认模式**：单个 skill + dry-run（最轻量）。

### Phase 0.5: 测试 Prompt 设计（效果维度必需）

只在 `--with-baseline` 时执行：

1. 读取目标 SKILL.md，理解它的宣称能力
2. 设计 2-3 个测试 prompt：
   - happy path（最常见场景）
   - 复杂/歧义场景（1 个）
3. 保存到 `.claude/skills/<skill-name>/test-prompts.json`：
   ```json
   [
     {"id": 1, "prompt": "典型用户输入", "expected": "期望输出简述"},
     {"id": 2, "prompt": "边界场景", "expected": "..."}
   ]
   ```
4. **展示给用户确认后再跑**

### Phase 1: 结构维度打分（维度 1-7）

主 Agent 直接读 SKILL.md，逐维度打分：

```
维度 1 Frontmatter: 8/10
  - ✅ name 规范，触发词齐全
  - ⚠️ description 无中文触发词

维度 2 工作流: 6/10
  - ✅ 有 Phase 分层
  - ❌ Phase 2 无具体 Step
  ...
```

### Phase 2: 效果维度打分（维度 8）

#### 模式 A：dry-run（默认，零成本）

读完 SKILL.md 后模拟执行：
- "如果给这个 skill 用户 prompt X，按 workflow 跑下来会输出什么？"
- 对比心目中合格输出，打 1-10 分
- 标注 `eval_mode: dry_run`

#### 模式 B：with-baseline（`--with-baseline`，成本高）

对每个测试 prompt，**并行** spawn 两个 Explore agent：

```
Agent A (with-skill):
  prompt: "你是带着 `<skill-name>` 这个 skill 的 Claude Code。
           按照 `.claude/skills/<skill-name>/SKILL.md` 的流程执行：
           用户输入：<test-prompt>
           输出最终结果。"

Agent B (baseline):
  prompt: "用户输入：<test-prompt>
           直接输出你的最佳回答。不要调用任何 skill。"
```

收集两组输出 → 主 Agent 打维度 8 分：
- 完成用户意图？（0-3 分）
- vs baseline 质量提升？（0-4 分）
- 负面影响（冗余/跑偏/格式奇怪）？（扣 0-3 分）
- 标注 `eval_mode: full_test`

### Phase 3: 输出评分卡

```
┌────────────────────────────────────────────────┐
│ Skill: <name>                   总分: 82/100 B │
├────────────────────────────────────────────────┤
│ 维度                          权重  得分  加权  │
├────────────────────────────────────────────────┤
│ 1. Frontmatter 质量            8    8    64   │
│ 2. 工作流清晰度                15   7    105  │
│ 3. 边界条件覆盖                10   6    60   │
│ 4. 检查点设计                  7    9    63   │
│ 5. 指令具体性                  15   8    120  │
│ 6. 资源整合度                  5    10   50   │
│ 7. 整体架构                    15   8    120  │
│ 8. 实测表现 [dry_run]          25   9    225  │
├────────────────────────────────────────────────┤
│ 总分                                     82   │
└────────────────────────────────────────────────┘

📉 重点短板:
  - 维度 3（边界条件）6/10：缺少 API 失败回退路径
  - 维度 2（工作流）7/10：Phase 2 只有散文无 Step

💡 建议改进（按 ROI 排序）:
  1. 在 Phase 2 补 Step 1/2/3 分层（预期 +8 分）
  2. 补充 "如果 X 失败则 Y" 的 fallback（预期 +4 分）
  3. description 加中文触发词（预期 +2 分）

🔗 详细评分理由: .claude/skills/skill-review/results.tsv
```

### Phase 4: 持久化评分历史

追加一行到 `.claude/skills/skill-review/results.tsv`：

```tsv
timestamp	skill	total_score	structure_score	effect_score	eval_mode	top_weakness	note
2026-04-14T09:40	mycc	82	79	90	dry_run	workflow	Phase2无Step
```

---

## 使用示例

### 单个 skill 干跑评估（最常用）

```
用户："评估一下 mycc 这个 skill"
cc: → skill-review mycc
    → 读 SKILL.md
    → 维度 1-7 静态打分
    → 维度 8 dry_run
    → 输出评分卡 + 短板 + 建议
```

### 全量扫描 + 干跑

```
用户："帮我给所有 skill 打个分"
cc: → 提示："73 个 skill，dry_run 大约消耗 ~200K tokens，确认继续？"
    → 用户确认后批量执行
    → 输出 Top 5 最弱 skill 建议先改
```

### baseline 对比实测

```
用户："认真评估一下 mycc skill，跑 baseline 对比"
cc: → skill-review mycc --with-baseline
    → 设计 3 个测试 prompt → 用户确认
    → 并行 spawn Explore agent (with-skill + baseline)
    → 对比输出 → 维度 8 打分
    → 输出评分卡（标注 full_test）
```

---

## 不做什么

- ❌ **不自动改 SKILL.md**。评分给建议，修改走 `skill-creator` 或人工 edit。
- ❌ **不自动循环棘轮优化**。darwin-skill 的 hill-climbing 循环暂不引入——成本高、边际收益不明、与 `atomic-experiments.md` 规则重复。
- ❌ **不评审非本地 skill**。插件/MCP 提供的 skill（如 codex:*、lark-* 的子命令）不在范围。

---

## 设计参考

- **8 维 Rubric**：darwin-skill（alchaincyf/darwin-skill，MIT License）
- **棘轮思想**：Karpathy autoresearch（不照搬循环，仅借鉴评估思路）
- **独立子 Agent 评分**：mycc 自有 codex-adversarial-review 架构的同构扩展

---

## 更新日志

- 2026-04-14 v0.1：初版。红标（8维 Rubric 抽取）+ 黄标（baseline 对比）合并落地。暂不实装棘轮循环。
