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

# autoresearch（多引擎入口）

本 Skill 的单一真源是：

`../../../.claude/skills/autoresearch/SKILL.md`

执行相关工作前，先完整读取该文件，并按其中的流程、约束与验收口径执行。
不要在本入口复制正文，避免多引擎版本漂移。
