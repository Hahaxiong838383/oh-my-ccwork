---
name: decision
description: 决策记录。在做完技术选择、架构变更、bug 修复、API 变更后，从当前对话上下文自动提取信息，生成结构化决策条目，追加到项目的 04-决策记录.md。触发词："/decision"、"记录决策"、"写决策记录"。也可在 /dev 或 /dev-team 流程末尾手动调用。
layer: 执行层
authorization: A区（自动执行，不等人确认）
output_levels: L1（结论）
---

# decision（多引擎入口）

本 Skill 的单一真源是：

`../../../.claude/skills/decision/SKILL.md`

执行相关工作前，先完整读取该文件，并按其中的流程、约束与验收口径执行。
不要在本入口复制正文，避免多引擎版本漂移。
