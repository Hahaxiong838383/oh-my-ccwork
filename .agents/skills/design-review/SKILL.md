---
name: design-review
description: 设计审计与修复。评估 UI 的视觉质量，检测"AI 垃圾"反模式，自动修复 CSS 问题，截图前后对比验证。支持快速/完整/diff 感知三种模式。触发词："/design-review"、"设计审计"、"UI 太丑了"、"视觉检查"、"polish"、"设计打磨"。
layer: 验证层
authorization: B区（展示问题清单，等确认再修复）
output_levels: L2（问题清单 + 修复结果）
---

# design-review（多引擎入口）

本 Skill 的单一真源是：

`../../../.claude/skills/design-review/SKILL.md`

执行相关工作前，先完整读取该文件，并按其中的流程、约束与验收口径执行。
不要在本入口复制正文，避免多引擎版本漂移。
