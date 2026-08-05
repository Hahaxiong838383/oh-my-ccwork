# 给 cc 的评审 Prompt：KidsHub Growth Insight 架构方案 v0.3

cc，请你评审并优化这个新项目方案：`/Users/rayman.chen/mycc/2-Projects/kidshub-growth-insight/docs/architecture-v0.3.md`。

## 背景

川哥要做一个内部投流情报系统，用于天猫/京东旗舰店投流前选达人、看小红书/抖音内容效果、看竞品淘宝/京东商品和评论。前期已经调研过 JustOneAPI、TikHub、Apify、MediaCrawler、ReaJason/xhs，以及蒲公英、巨量星图、生意参谋、京东商智等官方/第三方数据源。

## 已拍板决策

- 前端域名：`insight.kidshub.cn`
- 第一阶段部署：Studio 单机 MVP，有线 IP 访问
- Mini：不用
- dev198：不用来存数据/密钥/跑业务
- 首批账号：只给川哥 root
- 后续账号：川哥手动添加 editor/viewer
- 第一批品类/竞品：暂无，后台留输入口
- JustOneAPI Token：暂无，搭好后再申请/配置
- 蒲公英/星图/生意参谋/京东商智：暂无，后续川哥操作，系统保留导入入口
- 报表导出：后台手动配置
- 迁移：必须支持一键迁移
- 飞书日报：需要，但最低优先级
- AI/LLM：后续再接入，第一版只预留 provider/job/result/prompt 接口
- 建议技术栈：Next.js + Node.js/TypeScript + Prisma + PostgreSQL + Python Worker

## 请你重点评审

1. 架构是否足够简单，能否 2 周内做出可用 MVP。
2. Node.js/TypeScript + Python Worker 的边界是否合理，是否应改成 FastAPI 或全栈 Next.js。
3. PostgreSQL + Prisma 是否适合后续一键迁移、raw snapshot、CSV/Excel 导入和审计。
4. Studio 单机部署是否需要从第一版容器化，还是先用本机服务 + 脚本。
5. root/editor/viewer 权限模型是否够用，是否有遗漏的高风险写操作。
6. API Token 不回显、不入 git、不进迁移包明文的设计是否完整。
7. 一键迁移机制是否足够：PostgreSQL dump + raw data + uploads + reports + config template + manifest + healthcheck。
8. 数据表设计是否漏了关键实体：数据源、导入任务、采集任务、达人、内容、商品、评论、分析任务、人工标签、投放活动、复盘、审计、导出权限。
9. LLM 预留接口是否足够未来接 OpenAI/Claude/Grok/Ollama/Studio MLX。
10. 飞书日报最低优先级的预留方式是否合理。

## 请输出

请用中文输出：

1. `结论`：是否建议按当前方案推进。
2. `必须修改`：上线前必须改的架构问题。
3. `建议优化`：不阻塞 MVP，但建议纳入的改进。
4. `风险清单`：安全、数据、迁移、部署、成本、合规风险。
5. `MVP 切片`：建议第一版具体做哪些页面、接口、表和脚本。
6. `实施顺序`：按 1-2 周可执行节奏拆任务。
7. `最终推荐技术栈`：如不同意当前技术栈，请说明替代方案和理由。

请不要直接动代码，先只做评审与改进建议。

