# attention-audit — 注意力审计与检索策略优化

> 理论来源：ASAC（Attention Schema-based Attention Control）— 用轨迹统计抽象注意力状态并反馈控制
> 触发词："/attention-audit"、"检索审计"、"注意力分析"、"检索盲区"

## 定位

从 SQLite 检索轨迹中聚合统计，分析 cc 的「注意力分配」是否合理：
- 哪些记忆类别被高频命中（注意力热点）
- 哪些类别被 RRF 排名但从未注入（检索盲区）
- 预算使用效率如何
- 注意力预测的准确率（Phase 2）

## 执行步骤

### 第 1 步：读取轨迹统计

从 `0-System/memory.db` 的 traces 表读取最近 7 天数据：

```bash
# 通过 mycc 后端的 aggregateTraces() 接口获取
# 或直接查询 SQLite：
sqlite3 0-System/memory.db "
  SELECT injected, rrf, budget_used, budget_limit
  FROM traces
  WHERE created_at >= datetime('now', '-7 days')
"
```

### 第 2 步：生成注意力报告

分析维度：

| 维度 | 指标 | 健康阈值 |
|------|------|---------|
| **注意力热点** | Top 5 高频注入类别 | 集中度 <60%（前3类不应占超 60%） |
| **检索盲区** | RRF 排名过但未注入的类别 | 盲区数 <3 |
| **预算效率** | 平均 budget_used / budget_limit | 40%-80% 为健康区间 |
| **预测准确率** | predicted vs injected 的 F1 | >0.6 为良好（Phase 2 启用后） |

### 第 3 步：更新 blackboard.md

将注意力状态写入 `0-System/blackboard.md` 的「注意力状态」section：

```markdown
## 注意力状态

| 聚焦 | 负载 | 选择原因 |
|------|------|----------|
| [Top 1 类别] | [负载 1-5] | 基于 7 天轨迹：该类别命中率 X% |

**注意力热点**：[Top 3 类别]（共占 X% 注入量）
**检索盲区**：[盲区类别列表]（建议关注）
**预算效率**：X%（[健康/偏低/过载]）
```

### 第 4 步：发飞书简报

格式：
```
【注意力审计】YYYY-MM-DD

注意力热点：
1. [类别] — 命中 N 次（X%）
2. [类别] — 命中 N 次（X%）
3. [类别] — 命中 N 次（X%）

检索盲区（被排名但未注入）：
- [类别]（出现 N 次，建议检查是否需要提高优先级）

预算效率：X%
轨迹总数：N 条（7天）

建议：[如有异常给出调整建议]
```

### 第 5 步：异常检测

| 异常 | 条件 | 动作 |
|------|------|------|
| 注意力过度集中 | Top 1 类别占比 >40% | 建议检查是否有检索偏见 |
| 预算长期不足 | 平均使用率 >90% | 建议提升 budget_limit 或优化注入密度 |
| 检索盲区扩大 | 盲区数 >5 | 建议检查 KEYWORD_CATEGORY_MAP 覆盖率 |
| 零轨迹 | totalTraces = 0 | 正常（冷启动），跳过审计 |

## 运行模式

| 模式 | 说明 | 触发 |
|------|------|------|
| `report` | 生成报告 + 发飞书 | 默认 |
| `analyze` | 只分析不发送 | 调试用 |
| `update-blackboard` | 只更新 blackboard.md | 定时任务用 |

## 定时调度建议

```
| 23:00 | 注意力审计 | attention-audit | 每日检索策略分析 + 飞书简报 |
```

## 与其他系统的关系

- **context-loader.ts**：`applyHistoricalBoost()` 消费本 skill 产出的统计数据
- **MetaClaw**：如果注意力审计发现持续异常，可提升为 friction-pattern
- **evolution-log**：审计结果可触发新的 E-xx 进化项
- **blackboard.md**：审计结果自动写入注意力状态 section

*创建时间：2026-03-31*
*理论依据：ASAC (arXiv:2509.16058) + Cognitive Mirror (Frontiers 2025)*
