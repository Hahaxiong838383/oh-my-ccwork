---
name: metaclaw
description: MetaClaw 自进化引擎。从摩擦数据自动提取失败模式→聚类根因→生成反馈规则→注入未来行为。灵感来源：AutoResearchClaw 的循环学习机制。
interaction: skill
arguments:
  - name: mode
    description: 运行模式 (analyze/inject/report/full)
    default: full
  - name: days
    description: 分析窗口（天数）
    default: "7"
---

# metaclaw（多引擎入口）

本 Skill 的单一真源是：

`../../../.claude/skills/metaclaw/SKILL.md`

执行相关工作前，先完整读取该文件，并按其中的流程、约束与验收口径执行。
不要在本入口复制正文，避免多引擎版本漂移。
