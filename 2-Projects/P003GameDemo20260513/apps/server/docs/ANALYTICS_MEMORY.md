# P003 埋点服务端项目记忆

更新：2026-10-13。此文件是入 Git 的脱敏接手入口；全局共享记忆和私有实验、凭据、数据库仍存放在各自受控位置。

## 当前结论

- 服务端与后台已部署，容量优化运行源为 `9b63e7e9135d667c807562fd1581b0ea04ce5a07`。最后生产只读核验时间为 2026-10-13 16:17:38 CST；后续文档/Git 归档不是再次部署或新的生产在线证明。
- 原 14×30×200=84,000 条集中上传及维护重叠均通过；重叠 P95/P99 454/809ms、RSS 244.41MiB、193.646 秒、ACK/raw/seen 一致，仍有 198 次 503 退避。不能称吞吐提高或毫无背压。
- 真实采集保持关闭：全局 false/00 点、灰度名单 0、服务总闸 false，最后核验生产事件/seen/批次均为 0；真实首台、午夜和自动失败恢复待联合验收。
- 上传采用单 writer 64MiB、主查询只读 8MiB、fact 时间顺序键与 TTL 范围查找；FULL、提交后 ACK、10 秒独立 checkpoint、256MiB WAL 准入上限保持。

## 文档入口

| 用途 | 文件 |
|---|---|
| 给安卓端侧同事的开发回执 | [P003_ANALYTICS_CLIENT_RECEIPT_20261013.md](P003_ANALYTICS_CLIENT_RECEIPT_20261013.md) |
| 首台、签名、ACK、重试与对账联调 | [P003_ANALYTICS_SERVER_INTEGRATION_GUIDE_20261013.md](P003_ANALYTICS_SERVER_INTEGRATION_GUIDE_20261013.md) |
| 服务端部署与验收回执 | [P003_ANALYTICS_SERVER_DEPLOY_RECEIPT_20261013.md](P003_ANALYTICS_SERVER_DEPLOY_RECEIPT_20261013.md) |
| 本次容量增量回退 | [analytics-capacity-rollback-20261013.md](analytics-capacity-rollback-20261013.md) |
| 早期完整功能回退 | [P003_ANALYTICS_ROLLBACK_20261013.md](P003_ANALYTICS_ROLLBACK_20261013.md) |
| 完整实验与失败记录 | [analytics-capacity-optimization-20261013.md](analytics-capacity-optimization-20261013.md) |
| 脱敏通过回执 | [analytics-capacity-acceptance-20261013.json](analytics-capacity-acceptance-20261013.json) |
| 经验教训 | [analytics-postmortem-20261013.md](analytics-postmortem-20261013.md) |
| 服务器建议与重评条件 | [analytics-server-sizing-20261013.md](analytics-server-sizing-20261013.md) |
| 上传与后台合同 | [analytics-server-contract-v1.md](analytics-server-contract-v1.md)、[analytics-admin-api-v1.md](analytics-admin-api-v1.md) |

## 交付与代码归属

- 代码仓：`Hahaxiong838383/oh-my-ccwork`；本轮开发与归档分支：`codex/p003-analytics-20261013`。运行提交、容量文档基线 `787a03e6` 和后续复盘提交分别保留，提交日期不能替代线上源码校验。
- Studio 独立工作树：`/Users/fu-121/.codex/worktrees/p003-analytics-20261013`；本轮分支早期 `43c9dc36` 专门对齐 Air/生产源。它不是整仓 main 最新版，不能用全仓覆盖代替逐文件发布或直接重置 Air 的现役分支。
- Air 原仓：`/Users/rayman.chen/mycc`，现役分支 `p003/story-truncation-20260914`；本轮两次回流提交 `547236da3`、`c8d196c7`。容量回流 34 文件逐 SHA 一致，并保留 Air 原有 scripts/dependencies。不要为了同步切换其有未提交工作的分支。
- Air Downloads 已有 `P003-Analytics-容量优化联调交接-20261013.zip` 与同名解压目录；ZIP 71,538 字节，SHA256 `211950c7d9d79a89f6f91182b1552bbf15d12889e4a2fffbd5238f1bf52b5a3b`。2026-10-13 16:23:46 CST 再次核验 ZIP 与 12 个 payload 文件全部通过。
- 上述交接包冻结于 16:15，包内“未 push”描述是制作时状态，不用于判断后续远端状态；本次新增复盘与项目记忆单独入 Git，不改旧包及其校验清单。未代用户向同事发送消息。

## 恢复与保护

- 容量发布快照：`/opt/p003/server/backups/analytics-releases/analytics-capacity-predeploy-20261013T075722Z`；新正向 manifest：`analytics-release-capacity-20261013T075722Z/manifest.json`。
- 容量反向包对原 5 文件的生产预检已通过，未实际生产回滚。只停启 analytics；保最新数据库/WAL/seen/HMAC，不使用旧整体 `--code` 路径重启 3001，不恢复旧整库覆盖新写入。
- Studio 私有证据在 `1-Inbox/P003-埋点服务端摸排-20261013/capacity-optimization-20261013/`；最终 24 文件逐 SHA 校验、异机恢复材料和真实备份接收回执保留。全量原始日志、env、数据库不进入 Git。
- 维护重叠时每维 939,160 条事实，未越过原 1M/维度/日预算；末尾假库 1,006,360 events/seen、5,084 batches 全保留且隔离进程已停止。不能据末尾总量外推超 1M 整日汇总已过。
- 历史相关 analytics/容量/发布回滚测试已通过；全仓类型检查仍有 `race-llm.ts` 三处既存 `DeepseekLlmClient.abort` 错误。文档归档不等于本轮重新执行全量测试、生产压测或真人语音验收。

## 待办与不变边界

首台非儿童在用设备、真实午夜、Godot epoch/ticks 重试时钟疑点仍待端侧联合窗口。端侧上传默认关闭；错峰 10–20 分钟仅建议。现机已经通过本轮容量目标；先核实数据盘条件与成本，增长后再评估拆分埋点/语音，尚未购机迁库。历史语音不回复根因未确认，继续等自然复现。

署名：codex（OpenAI）| 2026-10-13
