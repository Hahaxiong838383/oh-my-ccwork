---
name: investigate
description: 系统化调试框架。铁律：修复前必须找到根本原因。四阶段：根因调查 → 模式分析 → 假设验证 → 实现验证。触发词："/investigate"、"帮我调试"、"为什么报错"、"根因分析"、"debug"。
layer: 分析层
authorization: A区（自动执行，不等人确认）
output_levels: L2（分析过程 + 结论）
---

# investigate（多引擎入口）

本 Skill 的单一真源是：

`../../../.claude/skills/investigate/SKILL.md`

执行相关工作前，先完整读取该文件，并按其中的流程、约束与验收口径执行。
不要在本入口复制正文，避免多引擎版本漂移。
