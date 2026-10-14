# P003 埋点服务端项目记忆

更新：2026-10-14。此文件是入 Git 的脱敏接手入口；全局共享记忆和私有实验、凭据、数据库仍存放在各自受控位置。

## 当前结论

- 服务端与后台已部署，既有容量运行源锚为 `9b63e7e9135d667c807562fd1581b0ea04ce5a07`。用户收到 v328 端侧反馈后新授权启用每日 23:00 策略；2026-10-14 17:22:31.095 CST 生效，17:24:53.367 独立核验。此次仅配置操作，没有修改或部署业务源码；Git 提交时刻不是新的生产在线证明。
- 原 14×30×200=84,000 条集中上传及维护重叠均通过；重叠 P95/P99 454/809ms、RSS 244.41MiB、193.646 秒、ACK/raw/seen 一致，仍有 198 次 503 退避。不能称吞吐提高或毫无背压。
- 当前仅 MCU/JWT sub 末 8 位 `03800006` 开启：目标 true/23、公网 cfg-21、独立白名单 1、总闸 true；全局 false/0，其他 13 台注册设备有效上传均 false。实际 RID 仍为 `ana-03800006-`；ADB 尾段 `07000180` 不能作为云端身份。v328 准备完成为端侧反馈，未独立核验 APK 或安装版本。
- 原窗口 10:43:41–11:13:41，到期于 11:13:42.216 实关；历史延长窗口 11:24:59 开始、原定 18:00，已于 13:44:02.941 提前关闭。两个旧 timer 仍 inactive/disabled、18:00 计划取消；新 owner 为 `nightly-20261014T091950Z-03800006`、mode=continuous_daily、expires_at=null，持续每日策略不自动到期。勿借旧窗口目录关新策略。
- 首轮 13 批 200：accepted2408/dup0/rejected27 invalid_properties、settlement2435。客户端报告 11:46:20 pending=0、27 条已终态移到 dead-letter；五类拒绝事件与具体非法属性仍待专项复验，新增 12 条没有逐事件来源证据。v326 后续 RID `ana-03800006-1a3fa379-1` 于 12:15:08.688 入库，19 accepted/0 dup/0 rejected。截至 13:45 累计 14 批、accepted/raw/seen2427、rejected27、settlement2454，无数据删除。
- 新开启后 17:23:00.886 真实入库 RID `ana-03800006-8c9f3f3c-8`，HTTP200、146 accepted/0 dup/0 rejected；17:24:53.367 累计 15 批、accepted/raw/seen2573、rejected27、settlement2600，2573+27=2600。这是首次补传正常路径证明，非今晚 23:00 自动调度取证；本轮 pending 尚未收到客户端回执，旧 pending=0 是旧时刻结果。
- 上传采用单 writer 64MiB、主查询只读 8MiB、fact 时间顺序键与 TTL 范围查找；FULL、提交后 ACK、10 秒独立 checkpoint、256MiB WAL 准入上限保持。

## 文档入口

| 用途 | 文件 |
|---|---|
| 当前 v328 每日 23:00 启用与真实补传 | [P003_ANALYTICS_V328_NIGHTLY_ENABLE_RECEIPT_20261014.md](P003_ANALYTICS_V328_NIGHTLY_ENABLE_RECEIPT_20261014.md)、[JSON](P003_ANALYTICS_V328_NIGHTLY_ENABLE_RECEIPT_20261014.json) |
| 历史阶段收口与关闭证明 | [P003_ANALYTICS_SINGLE_DEVICE_CLOSEOUT_20261014.md](P003_ANALYTICS_SINGLE_DEVICE_CLOSEOUT_20261014.md)、[JSON](P003_ANALYTICS_SINGLE_DEVICE_CLOSEOUT_20261014.json) |
| 客户端原始回执 | [P003_ANALYTICS_SINGLE_DEVICE_CLIENT_RECEIPT_20261014.md](P003_ANALYTICS_SINGLE_DEVICE_CLIENT_RECEIPT_20261014.md) |
| 历史开窗与首轮逐批对账回执 | [P003_ANALYTICS_SERVER_JOINT_RECEIPT_20261014.md](P003_ANALYTICS_SERVER_JOINT_RECEIPT_20261014.md)、[JSON](P003_ANALYTICS_SERVER_JOINT_RECEIPT_20261014.json) |
| 历史开窗期 11:39 只读检查点 | [analytics-joint-checkpoint-20261014.json](analytics-joint-checkpoint-20261014.json) |
| 本次联调经验教训 | [analytics-joint-postmortem-20261014.md](analytics-joint-postmortem-20261014.md) |
| 单机开关窗与恢复步骤 | [analytics-single-device-window-runbook-20261014.md](analytics-single-device-window-runbook-20261014.md)、[控制器](../deploy/analytics-window-controller.mjs) |
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
- 2026-10-14 新单机回执包为两机 Downloads 下的 `P003-Analytics-单机联调回执-20261014.zip`，7,023 字节，SHA256 `0a928c1ecfc8c9e2044b07e78326924b7e628095fb9ed5b41dc351006ca8b3ea`；包含冻结 MD/JSON/校验表 3 文件，两端逐字节核同。用户已确认发送给端侧同事；仓内回执复制原字节，不修改已发送文档。
- 最终收口作为新包交付：两机 Downloads 下 `P003-Analytics-单机联调收口-20261014.zip`，8,259 字节，SHA256 `4f861ad54786241bb2ea83dd11d27a9e2344a380c8497835c1c706aa5cb28d51`；收口 MD/JSON、客户端原始回执和校验表共 4 文件逐字节核同，保留旧包。Air mDNS、账号和 en0 本次重新核验，严格复用既知主机指纹；未操作 Air 代码仓。
- 新 v328 每日 23:00 启用回执为两机 Downloads 下 `P003-Analytics-v328-23点上传回执-20261014.zip`，5,327 字节，SHA256 `720f887a3f99cf94aabc151029c4d3e49fdf5910836559c0e20024087a0e9a1c`；新回执 MD/JSON/校验表 3 文件两端原字节核同，旧开窗与收口包保持。新回执包含 17:22 开启证明、17:23 真实补传与可执行关闭步骤，未代发端侧消息。

## 恢复与保护

- 容量发布快照：`/opt/p003/server/backups/analytics-releases/analytics-capacity-predeploy-20261013T075722Z`；新正向 manifest：`analytics-release-capacity-20261013T075722Z/manifest.json`。
- 容量反向包对原 5 文件的生产预检已通过，未实际生产回滚。只停启 analytics；保最新数据库/WAL/seen/HMAC，不使用旧整体 `--code` 路径重启 3001，不恢复旧整库覆盖新写入。
- Studio 私有证据在 `1-Inbox/P003-埋点服务端摸排-20261013/capacity-optimization-20261013/`；最终 24 文件逐 SHA 校验、异机恢复材料和真实备份接收回执保留。全量原始日志、env、数据库不进入 Git。
- 维护重叠时每维 939,160 条事实，未越过原 1M/维度/日预算；末尾假库 1,006,360 events/seen、5,084 batches 全保留且隔离进程已停止。不能据末尾总量外推超 1M 整日汇总已过。
- 历史相关 analytics/容量/发布回滚测试已通过；全仓类型检查仍有 `race-llm.ts` 三处既存 `DeepseekLlmClient.abort` 错误。文档归档不等于本轮重新执行全量测试、生产压测或真人语音验收。
- 本次私有窗口目录为 `/opt/p003/server/backups/analytics-windows/window-20261014T032410Z-03800006`；原窗口目录为 `window-20261014T024325Z-03800006`。两次关闭回执、延长窗口 `closeout-verification-20261014.json`、控制器、state、原 env/配置与日志保留，不将完整身份或原 env 入 Git；Studio 私有接手入口为 `~/.local/state/p003-analytics-joint-20261014/`，旧 window-extended.json 是历史开窗记录。
- 历史限时窗口的仓内控制器 SHA256 `ce318acbf81d64055d20346b5c204ebb47838d7e8d84d7604461d55a80bfa1e9`，与 13:44 关闭脚本一致。当时只重启 analytics 至 3122854/4，公司与个人 PID/restart 保持；13:45 公网 cfg-19 false/0、有效凭据空批 503 ANALYTICS_UPLOAD_DISABLED/Retry-After900 已验证，raw/seen/WAL/HMAC 保留。这是历史关闭证明，当前状态见新持续策略。
- 新持续策略私有目录：`/opt/p003/server/backups/analytics-policies/nightly-20261014T091950Z-03800006`。原 env/control/config、state、启用回执、独立验证、关闭恢复计划和操作原文均 0600；操作 SHA256 `700a3139a57cde5ee22bbb49f63c8afac24f15bb8a1b5d66b002c108ce3871f5`。本轮仅 analytics 重启为 3192914/5，公司 2817417/23、个人 1626403/0 保持；env 除独立名单外原字节保持，公网 cfg-21 true/23、目标空批 400 INVALID_BATCH、其他 active 空批 403 已验证。关闭命令见运行手册，恢复先关 gate 后目标 false/0、清名单，保最新 DB/WAL/seen/HMAC，未实际回退本次开启。

## 待办与不变边界

首台历史正常上传、三分区结算与客户端终态移队已阶段收口；当前新授权单机每日 23:00 持续开启，首次补传 146 条已核，真机 cfg 应用、v328 安装与新 pending 回执及真实 23:00 仍待。拒绝属性五类逐项复验、受控重放/混合 ACK/429/503/500/403、单独 401、有 pending 时关闭保队、同进程 false→true 另约专项，不扩大为全项通过。其他设备默认上传关闭；错峰建议、服务器选型及历史语音复现边界不变，未采购迁库。

本次收口经验：客户端终态证据与服务器持久计数分别记录，启动续传不等于同进程恢复通过；提前关闭必须同时读回公网配置、总闸、白名单和持久 timer，取消旧截止计划后不得冒称到点自动关闭已验证。新收口证据单独归档，旧已发送回执保持原字节。

署名：codex（OpenAI）| 2026-10-14
