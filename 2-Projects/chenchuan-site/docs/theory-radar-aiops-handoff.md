# Theory Radar AI Ops 维护交接

## 责任范围

AI Ops 的 Grok 4.5 是 Theory Radar 的后续维护人。目标是每日稳定生成并发布“脑科学 x LLM 前沿论文”，故障时优先保护个人站和最近一次健康归档，再恢复抓取、分析和发布链路。

## 当前生产架构

- 生产机：`aliyun-kr`，个人站 `/var/www/chenchuan-site`，PM2 进程 `chenchuan-site`。
- 服务：`/opt/theory-radar`；状态：`/var/lib/theory-radar`；配置：`/etc/theory-radar.env`，不得读取或输出其中 secret。
- 主链：六类 arXiv RSS + OpenAlex 专家补全；arXiv Query API 只做低频对账并带 429 熔断。
- 分析：Grok 4.5，严格 JSON Schema；验证 arXiv ID 集合后按候选顺序重排。
- 发布：`PUBLISH=true`；每日 timer 为 `theory-radar.timer`，周度对账为 `theory-radar-reconcile.timer`。
- 旧生产者：Mini 的 `cc.theory-radar-push` 已 disable + bootout，只保留脚本和 plist 用于灾难回滚。

## AI Ops 可见信息

只读快照包含服务代码、测试、systemd 单元、示例配置和本交接文档；不包含真实 `.env`、API key、运行报告正文和其他 secret。生产限权 `inspect` 返回：

- `PUBLISH` 是否启用，但不返回其他环境变量。
- 日报/周度 timer 状态和下次执行时间。
- 最近运行状态、阶段、日期、模型、论文数、发布结果、错误类型。
- RSS/OpenAlex 成功状态与计数。
- 最新公网归档文件名、个人站 PM2 与资讯雷达状态。

## 预授权动作

所有写状态动作仍需 AI Ops action token、精确确认词、冷却保护和动作后公网验收。

| 动作 | 确认词 | 用途 |
|---|---|---|
| `inspect` | 无 | 只读巡检个人站、资讯雷达和 Theory Radar |
| `run-theory-radar` | `RUN_THEORY_RADAR` | timer 漏跑或可恢复上游故障后，立即执行一次完整日报 |
| `restart-theory-radar-timers` | `RESTART_THEORY_RADAR_TIMERS` | timer 未 active、调度漂移或 unit 更新后重载定时器 |
| `refresh-radar` | `REFRESH_RADAR` | 资讯聚合缓存超过 20 分钟未更新时触发受控刷新 |
| `restart` | `RESTART_CHENCHUAN_SITE` | 仅个人站 PM2 异常且其他低风险恢复无效时使用 |

禁止自动删除报告、修改 `/etc/theory-radar.env`、切换 `PUBLISH`、启用 Mini 旧生产者、改代码、部署或 commit/push。代码修复由 Grok 先基于只读快照产出补丁方案，经川哥确认后进入受控实施；mycc 提交继续由 cc 收口。

## 故障决策

1. 先执行 `inspect`，区分页面故障、timer 故障、数据源故障、Grok 分析故障和 webhook 发布故障。
2. 页面仍有 last-good 时不得覆盖或删除归档；上游 429 不得用代理池或轮换 IP 绕过。
3. timer 非 active：确认后执行 `restart-theory-radar-timers`，再巡检。
4. timer 正常但当日未跑，且 RSS/OpenAlex/Grok/发布端可用：确认后执行 `run-theory-radar`。
5. 运行失败：保留 `/var/lib/theory-radar/state.json` 与 journal 证据，只记录错误类型，不把 prompt、回答正文或 secret 发飞书。
6. 发布后必须验证 state `status=ok`、`published=true`、`publish_result.ok=true`、论文数大于 0、公网 `/radar` 出现当日归档、首页和 `/radar` HTTP 200、PM2 online。

## 回滚边界

- 生产切换前备份：`/var/backups/theory-radar/pre-production-canary-20260714-110845/`。
- Mini 旧链备份：`~/theory-radar/backups/pre-korea-cutover-20260714-110845/`。
- 回滚涉及 `PUBLISH` 和跨机生产者切换，AI Ops 不自动执行；必须先向川哥报告证据、影响和步骤，确认后实施。
- 切回 Mini 前必须停止韩国发布，避免同一天两个生产者互相覆盖。

## 观察期与日常验收

- 2026-07-14 首次生产发布成功，共 8 篇；从该日开始观察 3 个真实发布日。
- 每个发布日检查运行日期、论文数、来源新鲜度、Grok 成功、发布成功、公网页面和重复/覆盖情况。
- 连续 3 个真实发布日通过后，关闭迁移观察待办，但保留每日巡检、周度 Query API 对账、last-good 与限权恢复动作。
