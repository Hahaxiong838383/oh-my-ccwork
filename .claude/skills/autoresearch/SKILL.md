---
name: autoresearch
description: 自主迭代优化。给定目标+可量化指标+时间预算，全自动循环：修改→验证→度量→决策→记录。
interaction: skill
arguments:
  - name: goal
    description: 优化目标的自然语言描述
    required: true
  - name: metric_cmd
    description: 度量命令（必须输出数字）
    required: true
  - name: direction
    description: 指标方向 (higher/lower)
    default: lower
  - name: guard_cmd
    description: 回归防护命令
    required: false
  - name: max_iterations
    description: 最大迭代次数
    default: "20"
  - name: scope
    description: 允许修改的文件范围（glob 模式）
    required: false
---

# AutoResearch — 自主迭代优化

> 灵感来源：karpathy/autoresearch + codex-autoresearch + claude-autoresearch
> 核心理念：给定目标 + 可量化指标，全自动迭代优化，直到达标或用尽预算。

## 启动协议

收到用户调用后，按以下步骤执行：

### 第 0 步：配置确认

1. 解析参数，确认以下信息：
   - **目标**：$ARGUMENTS.goal
   - **度量命令**：$ARGUMENTS.metric_cmd（必须输出一个数字）
   - **方向**：$ARGUMENTS.direction（higher = 越大越好，lower = 越小越好）
   - **防护命令**：$ARGUMENTS.guard_cmd（可选，如 `npm test`）
   - **迭代上限**：$ARGUMENTS.max_iterations（默认 20）
   - **修改范围**：$ARGUMENTS.scope（可选，如 `src/**/*.ts`）

2. 运行度量命令获取基线值（迭代 #0）
3. 如有防护命令，确认当前状态通过防护
4. 向用户简报配置，等待确认（简洁档可跳过）

### 第 1-N 步：自主迭代循环

每次迭代执行以下 8 个动作：

```
┌─────────────────────────────────────────┐
│ 1. 审视：读取 git log、结果日志、代码上下文  │
│ 2. 假设：基于历史成败，选择一个优化方向       │
│ 3. 修改：单一原子化变更（只改一个点）         │
│ 4. 提交：git commit -m "experiment: ..."   │
│ 5. 验证：运行度量命令，获取新指标值           │
│ 6. 防护：运行防护命令，检查回归（如配置）      │
│ 7. 决策：                                  │
│    - 指标改善 + 防护通过 → ✅ 保留           │
│    - 指标改善 + 防护失败 → 🔄 尝试修复(≤2次) │
│    - 指标未改善 → ❌ git revert            │
│    - 崩溃/语法错误 → 🔧 即时修复不计入迭代   │
│ 8. 记录：追加结果到 TSV 日志                │
└─────────────────────────────────────────┘
```

### 失败升级机制

| 连续失败 | 策略 | 动作 |
|---------|------|------|
| 1-2 次 | RETRY | 换参数/写法，同方向重试 |
| 3 次 | REFINE | 分析失败模式，换技术路径 |
| 5 次 | PIVOT | 回退到最佳状态，换优化方向 |
| 2×PIVOT | ESCALATE | 停止循环，向用户报告 |

### 日志格式

在项目根目录创建 `autoresearch-results.tsv`：

```
iteration	commit	metric_before	metric_after	delta	status	hypothesis	duration
0	abc1234	-	42.5	-	baseline	-	0s
1	def5678	42.5	38.2	-4.3	✅ kept	减少不必要的 re-render	12s
2	ghi9012	38.2	39.1	+0.9	❌ reverted	缓存查询结果	8s
```

### 终止条件

循环在以下任一条件满足时停止：
1. 达到迭代上限（max_iterations）
2. 连续 2 次 PIVOT 都失败（ESCALATE）
3. 用户手动中断（Ctrl+C）
4. 指标已无法继续改善（连续 5 次改善幅度 < 1%）

### 结束报告

循环结束后，输出简报：

```
📊 AutoResearch 完成报告
━━━━━━━━━━━━━━━━━━━━━
目标：[goal]
基线：[baseline] → 最终：[final]（改善 [delta]%）
总迭代：[n] 次（✅ [kept] 保留 / ❌ [reverted] 回滚）
关键改进：
  1. [最大改善的实验描述]
  2. [次大改善的实验描述]
失败教训：
  1. [最常见的失败模式]
```

## 适用场景

| 场景 | 度量命令示例 | 方向 |
|------|------------|------|
| 性能优化 | `npm run bench \| grep "ops/sec"` | higher |
| 减少包体积 | `du -sb dist/ \| cut -f1` | lower |
| 提升测试覆盖 | `npm test -- --coverage \| grep "All files" \| awk '{print $10}'` | higher |
| 减少 lint 警告 | `npm run lint 2>&1 \| grep "problems" \| awk '{print $1}'` | lower |
| 减少类型错误 | `npx tsc --noEmit 2>&1 \| grep "error" \| wc -l` | lower |
| 响应时间优化 | `curl -w "%{time_total}" -o /dev/null -s localhost:3000` | lower |

## 注意事项

1. **原子性**：每次迭代只做一个改动，确保可精确回滚
2. **不改测试**：除非目标就是测试本身，否则不修改测试代码
3. **范围约束**：如指定了 scope，严格限制在范围内修改
4. **Git 安全**：所有实验在当前分支进行，不创建新分支（用户可自行分支）
5. **任务结束后**：实验 commits 保留供审查，用户可选择 squash
