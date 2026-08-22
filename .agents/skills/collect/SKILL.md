---
name: collect
description: 每日信息采集。多源并行采集 → AI 分析 → 飞书简报。触发词："/collect"、"每日采集"、"早报"
layer: 分析层
authorization: A区（自动执行，无需人类介入）
output_levels: L1（结论）
---

# collect（多引擎入口）

本 Skill 的单一真源是：

`../../../.claude/skills/collect/SKILL.md`

执行相关工作前，先完整读取该文件，并按其中的流程、约束与验收口径执行。
不要在本入口复制正文，避免多引擎版本漂移。
