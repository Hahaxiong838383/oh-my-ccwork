---
name: retro
description: 工程复盘。分析近期 git 提交历史，生成工作节奏报告、代码质量信号、值得表扬的亮点。支持时间窗口（7d/14d/30d/24h）。触发词："/retro"、"做个复盘"、"最近工作怎么样"、"工程回顾"、"周复盘"。
layer: 分析层
authorization: A区（自动执行，不等人确认）
output_levels: L2（数据 + 分析）
---

# retro（多引擎入口）

本 Skill 的单一真源是：

`../../../.claude/skills/retro/SKILL.md`

执行相关工作前，先完整读取该文件，并按其中的流程、约束与验收口径执行。
不要在本入口复制正文，避免多引擎版本漂移。
