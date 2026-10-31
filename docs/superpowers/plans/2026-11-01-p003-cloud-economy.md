# P003 云端收益 P0 Implementation Plan

> **For agentic workers:** 使用 executing-plans，由 Codex 主会话实施，子代理只读审查。

**Goal:** 交付可在 HK 实际运行的只读云端试算和数据对账，明确正式接管缺口。

**Architecture:** 独立读取器读取原始观测，纯函数做区间并集/检查点审计及可选规则试算；影子库保存有界报告。既有语音、游戏和 Analytics 摄入路径不改变。

**Tech Stack:** 现有 Node 24、TypeScript、node:sqlite、zod；无新增依赖。

**Spec:** `2-Projects/P003GameDemo20260513/docs/cloud-economy-20261101/DESIGN.md`

## Global Constraints

- 生产源库只读；不重启主服务，不发奖，不设备回写，不改开关。
- 时长来源分离，缺失不填0；候选规则只生成条件试算。
- 真实有效规则与客户端输入完整性未验证前，ready_for_settlement恒false。

## Review Focus

- 重叠区间、相同ID异内容、检查点回退不可造成重复收益。
- 迟到数据、跨日、GM、版本混合、不同归属不可伪装完整。
- 读取源库时禁止自动建表、缺失文件创建、生产报告写回或读无限量正文。
- 报告与影子库身份范围、稳定摘要、重试不重复保存。
- 规则阈值单位、无输入与真实零值、边界取整可重现。

## Task 1 — 纯计算与规则

- [x] 建立 `apps/server/scripts/economy-shadow.test.ts`，先验证缺失实现失败。
- [x] 实现 `src/economy-shadow/contracts.ts`、`evaluate.ts`：严格范围、观测审计、纯规则函数。
- [x] 覆盖重复/冲突/回退/时钟/GM/逻辑日/阈值与重排测试，全部通过。

## Task 2 — 只读数据与报告存储

- [x] 实现 `src/economy-shadow/source.ts`，依赖 `{analyticsPath,telemetryPath,deviceKeySecret}`；只读且有界。
- [x] 实现 `src/economy-shadow/report.ts`、`store.ts` 与 `scripts/economy-shadow.ts`；输出 shadow-only JSON/Markdown。
- [x] 源库拒绝写入、同输入幂等、不同规则可重跑、恶意输出路径防护集成测试通过。

## Task 3 — 实际回放与交接

- [x] HK 版本化独立目录安装，源文件 SHA 核验；运行测试与三台目标设备真实回放。
- [x] 复审、修复、主路径相关回归，记录所有失败与未覆盖项。
- [x] 记忆/实施回执/端侧最小接入清单落盘；Air Downloads 交付；选择性 commit+push 并核远端（最终Git状态见交付回执）。

## Ledger

- 开始：基线 39594625，复用现有隔离工作树与 Codeg 会话48；主仓无关脏文件不动。
- 裁定：P0不挂管理后台或定时任务，先交付真实可执行只读报告。避免增加语音主进程负担，也不把尚未冻结的经济协议冒充上线功能。

- 完成：源码f09f8191，34新增+50Ark+37遥测通过，定向tsc通过，独立复审通过；HK独立目录真实6回放与重复幂等通过，三健康200，生产配置/Ark/进程未变。正式有效时长和现行配表仍待端侧核实，禁止正式发奖。
