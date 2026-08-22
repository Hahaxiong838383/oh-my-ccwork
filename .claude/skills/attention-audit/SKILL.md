---
name: attention-audit
description: 注意力审计与行为漂移监控。理论来源：ASAC（Attention Schema-based Attention Control）+ Behavioral Drift Detection。触发词："/attention-audit"、"检索审计"、"注意力分析"、"检索盲区"、"行为漂移"
---

# attention-audit — 注意力审计与行为漂移监控

> 理论来源：ASAC（Attention Schema-based Attention Control）+ Behavioral Drift Detection
> 触发词："/attention-audit"、"检索审计"、"注意力分析"、"检索盲区"、"行为漂移"

## 定位

两个分析轴：
1. **注意力分析**：从 SQLite 检索轨迹（traces 表）聚合统计，分析记忆检索分配是否合理
2. **行为漂移监控**：从 task-log.md 提取行为指标，检测 cc 是否偏离预期工作模式

后端支持：`memory-db.ts` 的 `computeBehaviorDrift(cwd, days)` 函数

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

--- 行为漂移（14天） ---
任务总数：N | 日均：X
引擎分布：cc X% | codex Y% | gemini Z%
摩擦密度：X%（[健康/偏高/危险]）
摩擦热点：[skill1 ×N, skill2 ×N]（或 无）
任务类型：[Top 3 类型]
漂移信号：[正常 / 具体异常描述]
```

### 第 5 步：行为漂移分析（新增 v2）

从 `0-System/task-log.md` 读取最近 14 天数据（通过 `computeBehaviorDrift(cwd, 14)`）：

| 维度 | 指标 | 健康阈值 | 漂移信号 |
|------|------|---------|---------|
| **引擎集中度** | cc 占比 | 70%-90% | >95% 说明 codex/gemini 路由失效 |
| **摩擦密度** | friction_skill 非空占比 | <10% | >15% 说明系统不稳定 |
| **摩擦热点** | 同一 skill 出现 ≥3 次 | 0 个 | 有热点则提升为 E-xx 进化项 |
| **任务类型多样性** | 类型种类数 | ≥3 种 | ≤2 种说明功能利用率低 |
| **日均产出** | 每日任务数 | ≥2 | 连续 3 天 <1 说明停滞 |

```bash
# 直接解析 task-log.md（后端不运行时的备用方案）：
grep -c "^|" 0-System/task-log.md  # 总行数
grep -c "friction_skill.*[^—-]" 0-System/task-log.md  # 有摩擦的行
```

### 第 6 步：异常检测

| 异常 | 条件 | 动作 |
|------|------|------|
| 注意力过度集中 | Top 1 类别占比 >40% | 建议检查是否有检索偏见 |
| 预算长期不足 | 平均使用率 >90% | 建议提升 budget_limit 或优化注入密度 |
| 检索盲区扩大 | 盲区数 >5 | 建议检查 KEYWORD_CATEGORY_MAP 覆盖率 |
| 零轨迹 | totalTraces = 0 | 正常（冷启动），跳过注意力审计 |
| 引擎路由单一 | cc 占比 >95% | 检查 codex/gemini 路由关键词是否匹配实际任务 |
| 摩擦密度升高 | 14 天内 >15% | 检查近期摩擦根因，提交 evolution-log E-xx |
| 产出停滞 | 连续 3 天日产出 <1 | 检查定时任务是否正常、是否有阻塞 |

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

- **memory-db.ts**：`aggregateTraces()` 聚合检索轨迹，`computeBehaviorDrift()` 聚合行为指标
- **context-loader.ts**：`applyHistoricalBoost()` 消费本 skill 产出的统计数据
- **task-log.md**：行为漂移分析的数据源
- **MetaClaw**：如果审计发现持续异常，可提升为 friction-pattern
- **evolution-log**：审计结果可触发新的 E-xx 进化项
- **blackboard.md**：审计结果自动写入注意力状态 section

*创建时间：2026-03-31*
*v2 更新：2026-03-31 — 新增行为漂移监控维度*
*理论依据：ASAC (arXiv:2509.16058) + Cognitive Mirror (Frontiers 2025)*
