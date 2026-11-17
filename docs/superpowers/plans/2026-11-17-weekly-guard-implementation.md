# 小程序护眼周报实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 完成已批准三步：统一后台日/周计算、持久发布与补传修订、后台和现役小程序同源展示，并经 Codex 与 Grok 交叉验收。

**Architecture:** 复用现有 Telemetry/历史时长读取，新增独立纯计算和 SQLite 周报持久层。原 parent weekly-report 路径及旧字段保留，在 data.report 中兼容增加完整周报；新增后台对应只读入口。后台定时更新与读取即时核对共用计算，已保存日结果不能因原始保留清理消失。

**Tech Stack:** TypeScript、Hono、node:sqlite、既有 Vue 单 HTML 后台、现役小程序适配层。

**Spec:** /Users/fu-121/Downloads/P003_MINIAPP_WEEKLY_CALCULATION_PLAN_20261117.md（用户已批准实施）。

## Global Constraints

- 原上传协议、ACK、已有 dashboard/业务/R1/身份逻辑不变；旧 weekly 字段保留，修正默认北京时间周一起点。
- 单台选中设备、Asia/Shanghai、周一00:00到下周一00:00；原始毫秒去重后重叠/相接区间合并，正间隙断开。
- 主值真实片段秒数；补充估算单列；正式日均分母7；连续>=300000ms为已确认活跃日。
- 提醒只数唯一played事件；缺测null不伪造0；周日22点首版、周一补全、迟到更新版本；每项独立可用。
- 不注入真实设备业务数据，不扩大历史授权；当前绑定读取前后校验，报告按授权范围隔离。
- 必须找到并核实现役小程序接入或明确缺失证据；参考构建不可冒充现役手机验收。
- 用户已授权实施、上线、提交推送及Grok交叉验证；无需再次请求程序性确认。

## Review Focus

- 299999ms/300000ms、跨午夜、同分钟重复/部分重叠、毫秒间隙。
- 无数据、纯估算、纯冷却、非法时间、依赖失败不能产生假0。
- 已发布结果在原始清理后保持，补传可增量修订且published_at不变。
- 读中解绑/换绑再换回、旧角色、异家长、迟到客户端响应均不得串数据。
- 定时任务失败隔离、周末22点/24点、启动补跑、原接口字段回归与真实页面入口。

## Task 1: 日周纯计算

- [ ] 新建 apps/server/src/weekly-calculation.ts：导出合法日期/周一起点和 buildWeeklyCalculation；读取原始事件与可选补充日结果，无I/O。
- [ ] scripts/weekly-calculation.test.ts：先复现默认周二、连续边界、跨日/去重、估算隔离、空态，再通过对应实现。

## Task 2: 持久化、授权、发布和接口

- [ ] 新建 weekly-report-store.ts/weekly-report.ts：保存按授权范围隔离的每日证据及周版本；保持历史、修订幂等、22点发布与定时/启动补跑。
- [ ] 原 routes/telemetry.ts weekly GET保留原字段，在data.report增加新结果；routes/miniapp-admin.ts新增同源weekly GET；index.ts启动轻量定时器。
- [ ] scripts/weekly-report.test.ts：真实SQLite/HTTP权限、补传/清理、重启、定时及兼容；已有telemetry/history/admin回归。

## Task 3: 后台和小程序

- [ ] 后台新增周报预览标签、切周、三项指标、真实/补充/每日证据和版本/空态；保持现有导航、解绑确认、隐藏对话。
- [ ] 定位现役小程序仓库并接同一GET结果；切设备/退出/刷新时使迟到响应失效；不可只改DemoIndex。
- [ ] 两端构建/浏览器fixture及生产原字节响应验证，原有字段和功能不回退。

## Task 4: 交叉验收、发布、交付

- [ ] Grok设计复核（task_id=4cb6c562-bed3-4d41-8c2f-6e3f0cc54af7）与完成源码的独立交叉测试，逐项修复后复测。
- [ ] 生产源码对撞、基于现役基线隔离Node22回归、备份、空闲发布，真实家长A/C与后台逐字段核对。
- [ ] 人话总结、接口有数据/无数据/错误样例、逐项验收矩阵及交付文档，commit/push远端核同。
- [ ] 仅全部目标证据成立才完成goal；现役客户端/真实验证缺失不能标整体完成。
