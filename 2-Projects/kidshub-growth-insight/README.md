# KidsHub Growth Insight

面向天猫/京东旗舰店投流前决策与投后复盘的内部情报系统项目。

## 当前状态

- 阶段：M5.6 MediaCrawler 研究采集与结果详情已由川哥真实体验验收
- 部署决策：Studio 单机 MVP，前端域名 `insight.kidshub.cn`
- 当前体验入口：`https://insight.kidshub.cn`（固定公网域名，不使用 Cloudflare Quick Tunnel）
- 主技术栈：Next.js 15 App Router + TypeScript + PostgreSQL 17 + Prisma；第一版不引入 Python Worker
- 数据层：37 张业务表，M1 已验收
- 认证层：数据库 Session、root/editor/viewer RBAC、登录限流、强制改密、Session 吊销、审计和 CSRF 防护，M2 已验收
- 账号管理：root 可创建 editor/viewer、改角色/状态、吊销 Session；当前正式用户仍只保留川哥 root
- AI 分析：第一版不接 LLM，只预留 provider/job/result/prompt 接口
- 数据导入：M5 CSV / Excel 导入管线已完成
- 研究采集：M5.5 MediaCrawler 小红书/抖音手动采集已完成，单任务且单次最多 20 条
- 结果查看：M5.6 可查看内容、匿名达人、原文链接、互动指标和已存评论数
- GitHub：`FUTURUS-ProductResearch/kidshub-insight`，当前业务提交 `0f965dae2b7ba6ad8f470c2209606adf04ac23af`

## 文件索引

- `docs/architecture-v0.4.md`：**当前施工蓝图**（Phase 1 全量，37 张表 / 13 个入口 / 20 个工作日）
- `docs/m2-day5-6-acceptance.md`：M2 实施、验收证据、经验教训与 Day 7 入口
- `docs/day7-account-management-acceptance.md`：Day 7 账号管理验收、负向验证与经验教训
- `docs/m3-day8-11-acceptance.md`：M3 五类主数据、别名合并、负向验证与交付证据
- `docs/m4-day12-13-acceptance.md`：M4 数据源、Token 安全、真实校验、配额与脱敏证据
- `docs/mediacrawler-public-access-acceptance.md`：M5.5/M5.6、扫码采集、结果详情、固定公网入口验收与故障复盘
- `docs/next-todos.md`：M5.6 之后的 P0–P3 工作清单和验收门槛
- `docs/cc-review-v0.3.md`：cc 评审记录（结论 / 必须修改 / 风险 / 技术栈，含 2026-08-05 双机实测校准）
- `docs/architecture-v0.3.md`：历史方案稿（已被 v0.4 取代，保留备查）
- `prompts/cc-review-architecture-v0.3.md`：给 cc 的评审、改进和优化 prompt
