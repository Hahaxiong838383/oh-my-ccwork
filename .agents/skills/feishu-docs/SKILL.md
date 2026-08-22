---
name: feishu-docs
description: 查飞书开放平台开发文档（卡片 JSON、服务端 API、组件属性、字段枚举）。文档站是 SPA，WebFetch 只能拿到导航壳、正文全空，必须走浏览器工具；URL 不可猜，要从页面里抓真实链接。触发词："飞书文档"、"飞书卡片 JSON"、"open.feishu.cn/document"、"飞书组件属性"、"飞书 API 字段"、"卡片 2.0"
layer: 工具层
authorization: A区（只读浏览，无副作用）
output_levels: L1
---

# feishu-docs（多引擎入口）

本 Skill 的单一真源是：

`../../../.claude/skills/feishu-docs/SKILL.md`

执行相关工作前，先完整读取该文件，并按其中的流程、约束与验收口径执行。
不要在本入口复制正文，避免多引擎版本漂移。
