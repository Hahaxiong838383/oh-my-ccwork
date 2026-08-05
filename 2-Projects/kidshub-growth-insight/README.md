# KidsHub Growth Insight

面向天猫/京东旗舰店投流前决策与投后复盘的内部情报系统项目。

## 当前状态

- 阶段：方案评审前
- 部署决策：Studio 单机 MVP，前端域名 `insight.kidshub.cn`
- 主技术建议：Next.js + Node.js/TypeScript + PostgreSQL + Python Worker
- 账号策略：第一版只初始化川哥 root，后续由 root 手动添加 editor/viewer
- AI 分析：第一版不接 LLM，只预留 provider/job/result/prompt 接口

## 文件索引

- `docs/architecture-v0.4.md`：**当前施工蓝图**（Phase 1 全量，33 张表 / 13 个入口 / 20 个工作日）
- `docs/cc-review-v0.3.md`：cc 评审记录（结论 / 必须修改 / 风险 / 技术栈，含 2026-08-05 双机实测校准）
- `docs/architecture-v0.3.md`：历史方案稿（已被 v0.4 取代，保留备查）
- `prompts/cc-review-architecture-v0.3.md`：给 cc 的评审、改进和优化 prompt

