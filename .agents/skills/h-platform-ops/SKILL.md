---
name: h-platform-ops
description: H 平台与 feishu-grok-bridge 运维入口。用于多用户 BYOS 飞书 Bot、Grok/Kimi/国产订阅、Kimi K3、长任务后台送达、授权、生产部署和真机验收。触发词："H 平台"、"feishu-grok-bridge"、"Luxapex Bot"、"Kimi K3"、"长任务完成卡"、"鸿轩 Bot"。
layer: 项目层
authorization: B区（生产变更需用户明确授权）
output_levels: L2
---

# H 平台运维入口

本 Skill 的单一真源是：

`../../../.claude/skills/h-platform-ops/SKILL.md`

执行任何 H 平台、`feishu-grok-bridge`、Kimi Code、后台任务送达或用户 Bot 排障前，先完整读取该文件并按其铁律、模型契约、部署和验收流程执行。不要在本入口复制正文，避免多引擎版本漂移。
