# R3：03800006 P1搜索全天体验窗口

**已实际开窗，待真机验收。** 开始：2026-10-21 20:27:30.087 CST；固定截止：2026-10-22 23:59:00 CST。完整SN BJP00326070803800006，持有人确认现场v353 / 1.2.2-canary.339，云端最近版本一致；开窗前最近真实成功认证记录为2026-10-21 20:22:04.998。没有把服务端合成签发当作真实设备上线/实听。

## 授权与范围

用户明确要在该设备体验搜索叠加效果，明天全天可测；普通聊天对照由其他设备提供。本轮按最新授权撤销“同机30轮基线先完成”和“首轮只2小时”的体验前置。跨设备对照不等于严格同机性能/P95验收。只开P1，P2未开，不扩大设备范围、不无限续期。

## 代码与部署

- Brain提交 `36272071da23996a295493b01dfed00767f1488d`；Worker提交 `3a86e0b7c0dc0c58e96364fd14ab27097ba5028b`，沿用原两分支，无合main。
- 签发策略、候选请求边界、Worker metadata校验及后台状态统一36小时硬上限。实际截止固定，不用滚动续租延长测试。
- 生产只更新search-canary-policy.ts、search-canary-status.ts、routes/search-canary-admin.ts和admin/index.html；原有其他src指纹不变。候选更新guard/policy；候选业务源码仍为f5f1d1e1基线+上述R3边界增量，没有整树覆盖生产。
- 候选Worker新产物SHA256 `1875dbf2abc979ebeec7f41830dd6e7c677cf305ea8348aeb34a8524e6ed4f08`，72980816 bytes；355项Linux单测、release、GLIBC≤2.39/GLIBCXX最高3.4.31门禁通过。43个构建输入核同。
- 候选PID715225/NRestarts0，已跨3分钟复核；现役Worker PID839/NRestarts0、SHA `deea58bf0a594a9a86a0d422fec2e36289b1f7c97b3c4857aa0e313ba5d9163d`不变。
- 生产Brain空闲时一次加载边界改动，PID1135240/restarts28；个人站和Analytics进程未变。候选独立重启，无其他设备开关修改。
- 候选Worker搜索env=1、完整SN唯一名单；候选Brain search=true/tools=false、同一截止；生产最后单事务开启SN派单，generation=R3-20261021-full-day。开窗后真实HTTPS签发验证目标进候选、JWT/响应一致、首句合同与开窗前保持、另一已登记设备继续rust-worker、伪造body SN仍403。该签发测试不连接RTC、不冒充真机听到。

## 固定截止与关闭验证

两台服务器各安装持久systemd timer `p003-search-expire-20261022.timer`，实际OnCalendar对应北京时间10月22日23:59。到时只关闭匹配本次截止的配置，不影响以后不同窗口；失败自动重试，不创建新窗口、不延长截止。

Brain侧关闭生产派单及候选search/tools，Worker侧原子写window.enabled=false。与此同时，签发/候选路由独立校验截止，Worker watchdog每秒校验并结束已有会话，因此不只停止新派单。

本轮短窗真实实测（合成RTC，非设备扬声器）：

- 截止2026-10-21 20:24:40.000；Brain timer于20:24:40.186关闭两侧配置；Worker timer成功、window=false。
- Worker 20:24:40.522触发关闭，20:24:41.052删房；探针disconnected=true，jobs恢复0。
- 短窗probe timer已禁用；正式timer两侧enabled/active，固定截止1792684740000。
- 明日实际到期尚未发生，届时状态不能提前标通过。

## 功能验证与边界

- TS类型检查、界面完整Vue/WebKit、状态与权限、SQLite隔离/保存、36小时边界及越界拒绝、固定截止幂等/不提前关闭/不干预新窗口测试通过。
- device-session 44/44，策略正例+13失败关闭分支，隔离进程与search-runtime测试通过。
- 新二进制合成普通RTC三通道与短窗断开通过。
- 明确固定长窗口下P1真实搜索任务79e7ea52-5f5c-4d94-933b-c12b3848ef11：delivered/completed，无error；RTC收到10.12秒有效音频、用户final1/agent final2/metrics3，input/output_ready各1。不是扬声器实听，也不替代真人并行聊天/插话等验收。
- 真人搜索并行、首句、本地回复语、取消/改查/续讲、内容质量、全天长稳均仍待现场。普通聊天跨设备比较单列，不声称同机性能过门。
- 搜索沿用单设备北京时间每日100条任务上限；取消和改查计入，未额外扩大付费额度。

## 传输与执行问题记录

构建机SSH链路间歇超时、裸大文件吞吐低，完整下载两次未完成，未安装残缺产物。改用差分：在同一隔离构建目录重建旧版并核到旧产物完整SHA一致，生成27341字节差分（20个4KiB块）；目标机先assert旧SHA，再恢复新文件并assert72980816字节及完整新SHA与已测产物一致，成功退出后才stop/替换/start。旧版重建只是差分基底，新版源码与已测产物已恢复，未把重建旧版当候选发布。

备用SSH路径中发现一处历史中继主机密钥不符，未绕过StrictHostKeyChecking、未更新known_hosts，最终用原已验证构建机链路。没有为传输改生产网络。

私有窗口编排脚本初次占位符替换破坏CALENDAR变量，失败发生在配置启用之前，探针被关闭窗口保护拒绝；修正为单词边界替换后重试。短窗口截止使用整秒以避免定时器早于毫秒截止运行。正式截止是固定整秒。失败未被记作已开窗或测试通过。

## R3回滚点

| 位置 | 备份与SHA256 |
|---|---|
| Brain | `/opt/p003/server/backups/search-canary-R3-20261021T122000Z/brain-R3.tar.gz`；`0a784562029ab55feb3430718db9c90e34d0da3f62791ffacf1e0a48b6b13b78` |
| Worker | `/root/rust-worker/backups/search-canary-R3-20261021T122000Z/worker-R3.tar.gz`；`104fc00d5a33d20bef7b01610333eb5ecd457c806848ff306fb3d682485f34e3` |

私有env与配置备份留服务器，不进Git。R1/R2均保留。

异常优先：生产canary.enabled=0 → 候选search.enabled/tools=0 → Worker window.enabled=false，等watchdog结束候选房间。目标设备退出重进恢复现役。该操作不必回退二进制。需要完整R3回退时先停正式timer，确认无候选job，再stop候选并恢复R3包中的binary/env/window；Brain只恢复本次变更文件、空闲时加载，不整库还原、不覆盖后续写者。保留账本与日志、不回灌生产人格/埋点。

## 交付

- [设备开窗回执](P003_SEARCH_CANARY_DEVICE_TEST_RECEIPT_20261021.md)，已覆盖旧“未开窗”回执；Air原文件保留pre-R3副本。
- [17项测试用例](P003_SEARCH_TEST_CASES_20261022.md)，含5分钟快速体验、预期表现、故障处理和反馈模板。
- [实际窗口](R3_WINDOW_20261021.json)、[Air传输哈希](R3_AIR_TRANSFER_20261021.json)、[构建输入](R3_WORKER_SOURCE_MANIFEST_20261021.json)、[Worker实测](R3_WORKER_VERIFICATION_20261021.json)、[后台状态](R3_ADMIN_STATUS_20261021.json)。

署名：codex（OpenAI）| 2026-10-21 北京时间
