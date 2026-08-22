---
name: easytier-mesh-ops
description: 家↔公司 EasyTier 异地组网（chuan-mesh）的部署、排障与扩容 SOP。触发词："组网"、"异地组网"、"EasyTier"、"easytier"、"野草云"、"mesh-status"、"虚拟内网"、"连不上公司/家里的机器"、"10.10.10."、"10.10.61."、"子网代理"、"NAS 访问不了"、"P2P 打洞"、"加一台机器进组网"。涵盖：8 节点拓扑真值、僵死态识别、自愈与告警分级、部署脚本用法、排障决策树（连不上/变中继/丢包/设备列表空）、判读规则（哪些读数不可信）、平台差异坑。
layer: 基建层
authorization: B区（改生产机网络配置需明确 scope；hk-relay 是唯一发现节点，改它会短暂断全网发现）
output_levels: L1
---

# easytier-mesh-ops（多引擎入口）

本 Skill 的单一真源是：

`../../../.claude/skills/easytier-mesh-ops/SKILL.md`

执行相关工作前，先完整读取该文件，并按其中的流程、约束与验收口径执行。
不要在本入口复制正文，避免多引擎版本漂移。
