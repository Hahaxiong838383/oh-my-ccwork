---
name: rule-compress
description: 万能公式 v1 规则压缩引擎。对散文式规则文件（CLAUDE.md / rules/*.md / 任何行为约束文件）做 4 维优先级分析 + P0-P3 分层 + 索引下沉压缩。触发词："/rule-compress"、"压缩规则"、"万能公式压缩"、"规则瘦身"、"精简 CLAUDE.md"、"压缩记忆文件"。当用户提到"精简规则文件"、"规则太长了"、"压缩 xxx.md"等意图时也触发。
---

# rule-compress（多引擎入口）

本 Skill 的单一真源是：

`../../../.claude/skills/rule-compress/SKILL.md`

执行相关工作前，先完整读取该文件，并按其中的流程、约束与验收口径执行。
不要在本入口复制正文，避免多引擎版本漂移。
