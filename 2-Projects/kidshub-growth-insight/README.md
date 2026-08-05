# KidsHub Growth Insight

面向天猫/京东旗舰店投流前决策与投后复盘的内部情报系统项目。

## 当前状态

- 阶段：Phase 1 Day 7 已由川哥体验验收通过，下一步 Day 8–11 / M3 主数据管理
- 部署决策：Studio 单机 MVP，前端域名 `insight.kidshub.cn`
- 当前体验入口：`http://192.168.61.177:3200`（Studio 有线局域网）
- 主技术栈：Next.js 15 App Router + TypeScript + PostgreSQL 17 + Prisma；第一版不引入 Python Worker
- 数据层：37 张业务表，M1 已验收
- 认证层：数据库 Session、root/editor/viewer RBAC、登录限流、强制改密、Session 吊销、审计和 CSRF 防护，M2 已验收
- 账号管理：root 可创建 editor/viewer、改角色/状态、吊销 Session；当前正式用户仍只保留川哥 root
- AI 分析：第一版不接 LLM，只预留 provider/job/result/prompt 接口
- GitHub：`FUTURUS-ProductResearch/kidshub-insight`，Day 7 提交 `2e7d349861e091a08c2f5b013ebbea41ea05fa01`

## 文件索引

- `docs/architecture-v0.4.md`：**当前施工蓝图**（Phase 1 全量，37 张表 / 13 个入口 / 20 个工作日）
- `docs/m2-day5-6-acceptance.md`：M2 实施、验收证据、经验教训与 Day 7 入口
- `docs/day7-account-management-acceptance.md`：Day 7 账号管理验收、负向验证与经验教训
- `docs/cc-review-v0.3.md`：cc 评审记录（结论 / 必须修改 / 风险 / 技术栈，含 2026-08-05 双机实测校准）
- `docs/architecture-v0.3.md`：历史方案稿（已被 v0.4 取代，保留备查）
- `prompts/cc-review-architecture-v0.3.md`：给 cc 的评审、改进和优化 prompt
