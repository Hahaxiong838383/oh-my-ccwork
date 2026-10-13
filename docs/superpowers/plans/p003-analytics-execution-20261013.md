# P003 Analytics authorized execution

Global Constraints: production deployment authorized; leave every real-device upload false; use verified production source, no unrelated worktree edits or real-device actions. Keep accepted data and dedupe ledger on rollback. Public wording KidsHubAI-VoiceKit only. Secrets never in logs, arguments or Git.

Execution decisions approved by the controller: retain minimal replay facts for 90 days; commit bounded TTL pruning before rollup; run ingestion/maintenance/checkpoint on the dedicated official Node v24.19.0 / SQLite 3.53.3 runtime while leaving the existing voice runtime unchanged; independent checkpoint every 10 seconds with a 30-second deadline and low Linux CPU/IO priority, 32 MiB SQLite cache and fixed prepared statements. Do not weaken FULL durability, the 256 MiB WAL backpressure, or the original capacity gates. Publish global upload false / hour 0, independent allowlist empty and hot server gate false. Actual device and midnight acceptance remain pending client integration.

### Task 1: Backend contract, authentication, isolated ingest, admin APIs and rollup

Read this first — it is your requirements, with exact values. Work in `2-Projects/P003GameDemo20260513/apps/server` under this worktree. Implement all backend portions below (tasks 1–5), excluding production operations, Python backup implementation and HTML edits. No new runtime dependencies. Existing npm ci installed. Node local 24.19.0, production 22.22.2: use APIs supported on both.

Ownership: apps/server/src/device-credential.ts, src/analytics/**, src/routes/device-session.ts, src/config-store.ts, src/routes/device-config.ts, src/routes/admin-data.ts, scripts/analytics-*.test.ts, scripts/analytics-rollup.ts, package.json analytics-only scripts, deploy/analytics.ecosystem.cjs, docs/analytics-server-contract-v1.md. Add no secrets, do not read real .env or connect to servers/devices. Do not edit admin HTML, backup scripts or operational receipt.

Evidence inputs: `/Users/fu-121/mycc/1-Inbox/P003-埋点服务端摸排-20261013/` (handoff, OpenAPI, event directory), actual frozen producer source `/tmp/p003-analytics-client-review-20261013/` at daf7c17. A separate read-only analyst is extracting property schemas and will write `/Users/fu-121/mycc/1-Inbox/P003-埋点服务端摸排-20261013/event-property-schema-v1.json`; start auth/store/http while that completes, consume its artifact and verify compatibility before committing. Prefer rejecting extra/sensitive keys over silently dropping semantic fields.

HTTP internal API: produce a concise `docs/analytics-admin-api-v1.md` specifying exact response shapes for overview/daily, batches, events, registry, health and collection config; admin gateway paths `/api/admin/analytics/{overview,daily,batches,events,registry,health,collection-config}` proxy read-only internal routes. Expose global server gate/independent allowlist information via safe internal summary, not secrets/full SN. Config writes use existing device-config APIs, server total gate must have a hot-readable protected control file (ANALYTICS_CONTROL_PATH) so emergency rollback has no process restart dependency. Gate defaults disabled; allowlist empty denies all. Device-config off should produce 503/900, non-gray 403. Admin gateway uses short timeout, bounded response and existing admin-only middleware.

Isolation: do not import existing store singletons from analytics entry. JWT pure verification takes injectable revocation callback. Read SQLite live WAL with `readOnly:true`, never immutable; re-open per request or invalidate handles on replacement. Device HMAC stable independent secret, internal proxy secret separate, env path variables absolute and configurable. Ignore nonexistent config keys as false/23 but unavailable DB is 503. Match active/env admission semantics. Top-level exception logs must be bounded controlled codes, no rejected free text. Health must distinguish alive/readiness, gate closed is healthy.

TDD: Write meaningful behavioral tests first and capture failing command; use temporary directories and fake secrets/devices only. Test every 57 valid fixtures against producer schema, bad types/extra sensitive keys, exact ACK sets/digest, transaction failure, dedupe after TTL, revoked JWT and RO storage failure, admin roles, configs boundaries, HTTP full-body/JSON413, Retry-After. Run existing device-session/config/diagnostics/telemetry/OTA tests relevant to extraction once. No unconditional network/persona/voice code startup. Freeze constants from specification below; per-device 60rpm, process concurrency 2; global RPM finite and configurable (initial 600), disk warn8GiB/stop4GiB, hard byte/event limits.

Retention: raw events and receipts 14d received-based, daily 90d, dedupe retained throughout internal trial. Separate bounded maintenance/rollup command (root schedules), aggregations replay-safe: rebuild dirty day by upsert, no additive replay. Keep safe event key summaries and controlled reason codes available for per-ID reconciliation, no raw rejected payload. Batch attempts must preserve repeated X-Request-Id attempts independently.

Finish: self-review and commit only your owned files; no subagents. Report tests, red/green evidence, commit IDs, concise API shapes, operational env required and concerns to `REPORT_PATH` (controller supplies real path), then return only status/commit/test summary/concerns.

## 3. 必须保留的端侧合同

- 端点：`POST /v1/device/analytics/events:batch`，沿用既有设备 Bearer，身份取验证后的稳定设备主体，不接受正文指定设备身份。
- 外层：`schema_version=1`、`batch_id`（最长 96）、`sent_at_ms`、`client`、`events`；每批 1–200 条。
- 事件：`schema_version=1`、`client_event_id`（最长 128）、`event_name`（最长 96）、`occurred_at_ms`、`session_id`（最长 64）、`sequence`、`priority`、`context`、`properties`；priority 仅 low/normal/critical。
- 幂等键只认“鉴权主体 + client_event_id”。`batch_id`、`request_id`、会话或内容版本均不是事件幂等键。
- `X-Request-Id` 最长 96，合法值原样回显，不能 trim/截断后冒称原样；缺失、非法长度或不安全头值在外层校验拒绝。
- 设备时钟偏差不拒收，保留原 `occurred_at_ms` 和独立的服务端 `received_at_ms`；不能只存客户端时间。
- 单事件非法、未登记事件或敏感字段：HTTP 200 内按 ID 终态 `rejected`，未登记原因固定 `event_not_allowed`。无从解析或无法识别结算 ID 的外层合同错误才用 400。
- 401 只表达凭据问题；非灰度 403；关闭总闸 503、顶层 `error_code=ANALYTICS_UPLOAD_DISABLED`、`Retry-After: 900`。
- 限流/临时过载用 429/503，`Retry-After` 是数字秒，不能用 HTTP-date。成功 200 不依赖 `retry_after_ms` 让当前客户端退避。
- 每次成功回执必须完整、互斥、仅含本请求输入 ID，禁止 204、部分结算或未知 ID。

建议冻结的附加值：单事件 UTF-8 JSON 最多 8 KiB，应用批正文最多 2 MiB，端点专属 nginx 硬顶 3 MiB；每主体 60 请求/分钟，内部处理并发上限先设 2，过载快速返回带退避的 429/503。这些是提案值，须通过容量与拆批测试后才作为正式回执。

### 结算与重复的明确规则

1. 在一笔事务中写入新事件、幂等摘要和批次结算记录，提交成功后才能发 200；事务失败返回可重试 503，不提前 accepted。
2. 已见过同 ID、同事件内容：duplicated；同 ID、不同事件内容：`client_event_id_conflict` 终态拒绝，旧事件不改。
3. 同请求重复出现同 ID：先按 ID 分组。内容相同仅结算一次；新 ID 归 accepted，已有 ID 归 duplicated。内容冲突则该 ID 只归 rejected，不先插入其中一个版本。
4. 内容哈希只针对规范化后的事件，不包含 request_id、batch_id、上传时版本或 received_at，避免补传和凭据恢复被误判冲突。
5. 拒绝记录只留受控原因码和计数/安全 ID 摘要，不保存非法正文或自由文本错误说明。

例：A 是新事件、B 已存在、C 未登记，则回执为：

```json
{
  "ok": true,
  "request_id": "ana-testboot-1",
  "accepted_event_ids": ["A"],
  "duplicated_event_ids": ["B"],
  "rejected": [{"client_event_id": "C", "reason": "event_not_allowed"}],
  "retry_after_ms": 0
}
```

## 4. 配置、身份、存储与后台边界

**配置：** 在现有 `CONFIG_KEYS` 注册设备键 `analytics.event_upload_enabled=false`、`analytics.daily_upload_hour_cst=23`（0–23）。SN 覆盖 > global > 内置，revision/tombstone 规则不变。响应是在既有完整 `schema_version/revision/posture` envelope 内增加 `analytics`，不能只返回交接示例片段。配置 UI 和错误提示增加 hour 单位，保持原姿态策略校验不变。

**鉴权：** 从 `routes/device-session.ts` 抽出纯 JWT 校验核心，原路由继续使用并保持原导出接口。新服务用只读适配器核设备 active、撤销水位和开关；不能直接 import 旧路由引入写库初始化。读取台账/config 失败时返回临时 503，不伪装成 401 触发认领。现有台账/env 准入语义必须由回归保护。

**身份最小化：** analytics 使用经验证主体导出的稳定内部设备键；建议独立命名空间 HMAC，密钥走既有凭据库管理、保持稳定，不随 Bearer 续签变更。analytics 库/日志/看板不存完整 SN、凭据、孩子昵称或聊天内容。后台只返回别名/短哈希；凭据主体不直接作为页面字段。

**存储：** 建议 `/opt/p003/server/data/analytics.db`，WAL、提交耐久性启用 FULL，短事务及有界 busy timeout；只新增表，不迁移现役业务库。

| 表 | 内容与键 | 保留建议 |
|---|---|---|
| analytics_event | device_key、client_event_id、事件/发生/接收时间、session、sequence、priority、经白名单验证的 context/properties、上传端元数据引用；唯一(device_key, client_event_id) | received_at 起 14 天 |
| analytics_event_seen | device_key + event ID 摘要、规范事件 hash、首次接收时间；用于清明细后继续去重 | 内测期不自动删除 |
| analytics_batch | 独立接收记录 ID、request_id/batch_id、主体键、接收时间、三类计数、HTTP/处理耗时 | 14 天；request_id 建索引但不当全局唯一键 |
| analytics_day / analytics_device_day | 日汇总与设备日维度，用于去重人数、会话、漏斗和迟到重算 | 90 天 |

保留幂等摘要的原因：客户端 inflight 不受普通 14 天 prune 清理，不能假设所有重试都在 14 天内；删明细不能使旧已确认事件重新记账。原始 HTTP 请求默认不保留。清理按 received_at 分批，避开大 DELETE/VACUUM；每日在线一致备份，本机仅保最近 2 份、异机滚动 7 天，恢复演练纳入验收。

**后台：** 原 admin token 存在大脑进程内存，独立服务不能照抄验证。新增 `/api/admin/analytics/*`，先经过原 admin-only 权限再代理到回环内部查询；guest/editor 均不能进入。内部接口需服务间认证，公网 nginx 不暴露内部查询端点。UI 首先提供批次对账和趋势，普通家长端不加入口。

## 5. 调度与容量的真实约束

- 交接和代码默认 **23:00**；若按用户“凌晨”口径，建议灰度配置为 **00:00**，无须改客户端内置默认。不是系统准点闹钟：常驻协程约 5 分钟检查，关机或进程不在时不能承诺午夜上传。
- 开启后旧积压可能白天立即补传；灰度开启前必须让采集和背压已就绪，不能等午夜才看服务。
- 单批 200、间隔 2 秒、一轮最多 30 批，剩余 5 分钟后继续。14 台同时满轮次可达 84,000 条，但这不是单夜硬上限。
- 同一天队列排空后才标记完成；当天新事件留到次日，跨午夜结束可能记为新一天完成。服务器日报要显示数据截止时点和迟到补传，不把“没上传”直接判为“不活跃”。
- 语音/本地播放/配网/OTA 忙时延后；采集与聚合虽分进程，仍共享主机 CPU、磁盘和网络，所以要测语音指标并实施全局背压。
- 以每事件 1 KiB 净载荷作粗估，84,000×14 天约 1.12 GiB；8 KiB 则约 8.97 GiB，尚未算索引/WAL/备份。这是极端轮次假设，不是当前实测；不能按 19 GiB 空余宣称无限收。
- 初始监控：批次/秒、accepted/duplicated/rejected、处理 P95、进程 RSS、SQL busy、WAL大小、磁盘余量、聚合与备份最后成功时间；磁盘 <8 GiB 告警、<4 GiB 停接新事件并返回临时 503，不 accepted 后丢数据。
- 提议验收阈值：14台等效集中上报与续排下，健康摄入 P95≤500ms、P99≤2s；新API常态RSS≤256MiB、512MiB设进程保护线；原3001健康/配置小请求P95相对基线新增≤50ms。语音模型耗时另按自然请求对照，不用这些小请求冒充语音听感验收；样本不足则明确保留限制，不宣称全量无回归。

## 6. 端侧需要配合的最小事项

| 事项 | 已看到的边界 | 处理安排 |
|---|---|---|
| Godot 交接重试 | `_failed_flush` 给 epoch retry_at_ms，main 却与 ticks_msec 比较；一次 Bridge 失败后可能不再自动交接 | **联调前局部验证/统一时钟**；只测“失败一次→恢复→无需 force 自动交接”，不重开全量端侧开发 |
| JSON 413 | 拆到 1 条仍没有终止分支；HTML 413 会整批 dead-letter | 服务器保证合法 200×8 KiB 不撞代理硬顶，单事件非法用 200 rejected；联调补单条持续超限用例，再决定端侧最小保护 |
| 回执宽松 | 当前不校验 request_id、结算完整/互斥；200 退避字段也不会阻止下一批 | 服务器严格输出完整互斥回执，限流用 429；客户端严格校验作为后续增强，不把它当当前服务器放松合同的理由 |
| 关闭上传 | 配置 false 不立即停止已运行排空循环 | 必须同时关闭服务端总闸，503/900 秒；不能只下发 false 便认定已停止 |
| 版本元数据 | client_json 是全局最新值；旧事件可能带当前 content_version，且没有 Launcher build | 首版称“上传端元数据”，不能声称按事件发生版本统计；精确版本归因后续扩合同 |
| 语音状态 | 只有 state/interactive，没有 cloud room/turn/trace | 可做状态漏斗；不能用这些日批事件定位此前间歇不回复或计算逐轮回复率 |

这几项是静态核查和待联调用例；本轮没有端侧复现或修改。v321 原本地正常路径验收结论保留。

## 7. 首版看板口径

先提供运行对账，再提供七组日维度统计：设备活跃/会话、G1 主流程、逻辑日与生态缸、奖励与补勤、设置、语音状态、失败命令排行。

- 活跃设备是设备键去重，不是孩子人数；会话以 `app.session_started` 的设备键+session_id 去重。
- G1 漏斗用业务语义事件，奖励以 `g1.reward_granted` 等 Runtime 结果为准，不能用点击次数代替发奖次数。排序参考 sequence/occurred_at，不按批次到达顺序推导流程。
- 并列发生日/接收日；用 sent_at 与 received_at 的偏差及异常发生日期标记可疑时钟，保留原值。标记只是分析提示，不承诺修正设备时钟；可疑发生日单列，不污染正常漏斗。
- 迟到新事件把相应分析日标脏，定时从原始事件重算并 upsert，不在每次重放时累加日计数。时钟异常不生成无限历史/未来日期分区。
- 内测/GM 流量按明确设备分组或已有 gm_override 标记区分；没有标记时不推断“真实用户”。
- 展示最后接收时间/有批次到达的设备覆盖率，不能凭服务器记录断言客户端 pending=0。pending 要结合同事的本地审计对账。
- 不展示孩子画像、自由文本、精确事件发生版本、逐轮语音回复率或当前协议没有采集的数据。


### 任务 1：冻结合同与开发基线

**文件：** 导入 `docs/ANALYTICS_SERVER_HANDOFF_20261009.md`、`docs/ANALYTICS_EVENT_TRACKING.md`、`docs/api/analytics-event-ingest.openapi.yaml`；新增 `apps/server/docs/analytics-server-contract-v1.md`。

- [ ] 核全部将修改文件与生产 SHA；在隔离 worktree 建立实际基线，保留其它任务脏文件和现役未回流功能。
- [ ] 从 57 个 producer 冻结每事件字段类型/nullable/嵌套；context 仅 screen/phase/external_screen_connected，client 兼容现有 product/component/protocol_version/content_version。
- [ ] 冻结上文补充的字节限额、限流、重复冲突、拒收原因、保留期、后台权限、灰度主体和上传小时；不新增任意自由文本字段。

**验收：** 57/57 样例均可通过合法结构校验；非法/敏感属性有明确终态原因；文档与当前 v321 输出无冲突。

### 任务 2：独立鉴权与配置适配

**文件：** 新增 `apps/server/src/device-credential.ts`、`apps/server/src/analytics/device-context.ts`；修改 `src/routes/device-session.ts`、`src/config-store.ts`、`src/routes/device-config.ts`；测试 `scripts/device-session.test.ts`、`scripts/device-config.test.ts` 及新增 `scripts/analytics-auth-config.test.ts`。

**接口：** 纯鉴权继续产生原 `{sn}` 语义；新 `readAnalyticsDeviceContext(subject)` 返回 `{deviceKey, active, uploadEnabled, uploadHourCst}`，读取异常区别于无效凭据。服务端撤销/配置读取保持 mode=ro；不能为方便用 immutable 读取仍在变化的库。

- [ ] 先补无效凭据、撤销、续签主体稳定、active/env 回退、只读库不可用的回归用例，再抽取原函数，保持原路由导出兼容。
- [ ] 增加两配置键及合法嵌套快照，测 per-device 覆盖、删除覆盖、revision 单调、0/23 小时、关闭开关。
- [ ] 验证独立 entry 的 import 不打开现役写库、不启动语音/人格定时任务。

**验收：** 原 session/config/OTA/diagnostics 鉴权与配置回归通过；新开关默认 false、灰度可单独启停。

### 任务 3：耐久入库与精确结算

**文件：** 新增 `src/analytics/contracts.ts`、`event-registry-v1.ts`、`store.ts`、`ingest.ts`；新增 `scripts/analytics-ingest.test.ts`。

**接口：** `validateAnalyticsBatch(raw)` 校验外层；`validateAnalyticsEvent(raw)` 产生受控合法事件或拒绝原因；`settleAnalyticsBatch(context, batch)` 返回第 3 节 `AnalyticsBatchAck`，只在事务提交后完成。

- [ ] 先验证新事件/重放/冲突/同批重复/两主体同 ID/部分非法的精确集合结果。
- [ ] 建表、唯一键、预编译语句和整批事务；提交失败、响应前断链、重启后重放必须不丢不重记。
- [ ] 测明细清理后旧 ID 仍 duplicated，幂等摘要不随明细 TTL 消失。
- [ ] 所有持久字段经白名单；非法原文、敏感字段与自由文本不入日志/拒绝记录。

**验收：** 输入 ID 的去重集合严格等于三类结算集合并集，三类两两不交；commit 前任何故障都不能返回 accepted。

### 任务 4：HTTP 服务、背压和健康检查

**文件：** 新增 `src/analytics/index.ts`、`scripts/analytics-http.test.ts`、`deploy/analytics.ecosystem.cjs`、`deploy/nginx/analytics-location.conf`；package.json 仅增加对应启动/测试脚本。

- [ ] 提供回环 `127.0.0.1:3006` 的 PM2 `p003-analytics`，新增 health/readiness，不启动现役业务入口。
- [ ] 在解析正文之前限制字节；应用 413 返回 JSON，nginx 硬顶高于应用门。每主体/全局背压、总闸和错误响应按合同输出。
- [ ] 测数字 Retry-After、精确 request_id、200 空/交叉回执禁止、关闸503、非灰度403、凭据401、过载429/503、损坏JSON400。
- [ ] 一批合法 200×8 KiB 能经真实代理通过；较大可拆批，单事件违规可终态结算。

**验收：** 隔离 HTTP 与真实 nginx 测试通过，内网后台查询不能经公网地址绕过 admin；既有 `/v1/`、OTA和其它 location 不变。

### 任务 5：后台对账、聚合与运行维护

**文件：** 新增 `src/analytics/admin-query.ts`、`rollup.ts`、`scripts/analytics-rollup.ts`、`scripts/analytics-backup.py`、`scripts/analytics-ops.test.ts`；修改 `src/routes/admin-data.ts`、`apps/web/public/admin/index.html`。

**接口：** `/api/admin/analytics/batches` 按 request_id 查询接收尝试；`/events` 按 client_event_id 查询受控结算/事件摘要；`/daily` 和 `/health` 返回第 7 节指标及数据截止/接收状态。均由原 admin-only 网关认证后代理内部服务。

- [ ] 先测试 admin/editor/guest/未登录权限与上限分页，再加对账页；不提供无界原始 JSON 下载。
- [ ] 独立任务重算标脏日期及有限分析窗口，查询走聚合表；重放不改变原日计数，迟到事件只更新对应日。
- [ ] 时钟异常、跨日、历史日/补勤、重复领奖、跨生态缸、恢复补播分别验证统计口径。
- [ ] 清理、在线备份、校验与隔离恢复；备份恢复后唯一键和幂等摘要仍有效。按既有运维入口完成异机备份预检、权限与校验。
- [ ] 后台 DOM Vue 组件成对闭合，权限与既有配置/OTA/设备页回归；页面不暴露完整 SN、凭据主体或底层技术命名。

**验收：** 能按 request_id/client_event_id 对账、权限无回归、日汇总可重复计算一致，备份可恢复；不是只验进程 alive。


### Task 2: Existing production admin analytics UI
Use Task 1's frozen API; integrate approved prototype into actual single-file Vue admin. Keep existing navigation and behavior. Five tabs and seven metric groups, safe aliases only, real empty states, bounded pagination/time/device/ID filters, distinction of occurred vs received, no manufactured zero pending or reply rates. Native config keys reuse current per-device config editor. Entire template must compile on login page, Vue/Element tag pairs and permission gates retained. Source is git snapshot for deployment.

### Task 3: Operational backup, staging, review, deployment and documents
Controller owns deploy/maintenance/backup scripts, source manifests, reversible nginx exact location, protected environment/control generation, online backup and isolated restore, quantitative synthetic load and existing service latency checks, root-only pre-change backups, PM2 persistence, per-file deployment, source backflow to Air, and receipt/integration/rollback documentation. Never restore config.db/devices.db wholesale or erase analytics accepted records. Real-device/night-window checks stay explicitly pending colleague handoff.
