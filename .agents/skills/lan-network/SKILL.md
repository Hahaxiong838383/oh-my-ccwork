---
name: lan-network
description: 局域网设备网络连接运维：查有线/WiFi 链路是否真的正常、配静态 IP、切默认路由优先走有线、排"连不上"。含 192.168.61.0/24 有线段与 10.9.1.x WiFi 段真值表。触发词："有线网络"、"网线"、"交换机"、"静态IP"、"固定IP"、"网段"、"默认路由"、"优先走有线"、"检查网络连接"、"设备连不上"
layer: 基建层
authorization: B区（改生产机网络配置需明确 scope，Mini/dev198 均跑生产服务）
output_levels: L1
---

# lan-network（多引擎入口）

本 Skill 的单一真源是：

`../../../.claude/skills/lan-network/SKILL.md`

执行相关工作前，先完整读取该文件，并按其中的流程、约束与验收口径执行。
不要在本入口复制正文，避免多引擎版本漂移。
