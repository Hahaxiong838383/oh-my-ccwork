# T3 接续合同审查

结论：**T3_READY_AS_PLAN**

这是对 `docs/prnas-storage-50/t2-complete/T3_HANDOFF.md` 的计划审查。固定候选 `2183eb0cb843812582b5ca8adeac11ac1dd1d903` 上的合同可以交给主 13 实现。下面 7 条修正文句是实现时的规范性补丁，补的是判定和复用边界，不需要新服务、消息队列、第二套数据库或设备 OTA。

本结论 **不等于 T2 B5 通过**，**不等于生产通过**，也 **不是 T3 已实现**。未重跑 T2 全量审查，未启动或停止大库试验，未改工作树。

没有设计级阻断。若实现时不采纳修正文句，第 3、5、2 条会做成错误行为（字段表分叉、`Spool.publish` 每次新包、NAS 满直接打到设备 503）。

## 审查身份

| 项 | 值 |
|---|---|
| 模型 | Grok 4.7 |
| 固定 SHA | `2183eb0cb843812582b5ca8adeac11ac1dd1d903` |
| HEAD | 与固定 SHA 相同。提交说明：`fix(p003): prevent daily backup gaps from timer jitter` |
| 工作树 | 仅 `docs/prnas-storage-50/t2-complete/ROLLBACK.md` 有未提交改动。本次未读、未改。审查文件均无本地改动 |
| 范围 | T3 合同；`src/ark/store.ts`、`contracts.ts`、`routes.ts`；`src/storage/policy.ts`、`routes.ts`；为核对复用点读了 `scripts/storage-archive.py` 全文、`scripts/storage-nas-verify.mjs` 全文，以及 backup status / policy CAS / canonicalJson 的相关片段 |
| 未做 | 未部署，未改设备或生产，未写共享记忆，未发外部消息，未把规划改成代码 |

## 总判

合同规模是对的：仍是现有 Ark sqlite 加一个导出脚本，复用 `kind=ark_checkpoint`、`publish_prepared`、manifest v1 和 `storage-nas-verify.mjs`。第 29–39 行的顺序（同事务与门禁 → 导出/确认清理 → 后台状态 → 隔离故障回归）保持。T5/T6 的 50 台、语音和统一开设备继续留在后面。

T2 接口里，manifest 八字段、32 位 hex `archive_id`、`list` / `meta` / `read OFFSET` / `ack ID SHA BYTES COUNT`、重复 ACK 返回原 receipt、未知包不能 ACK、`fsync`→同卷 `rename`→目录 `fsync`，与 `Spool` 一致。`rotateBackups` 只轮换 `analytics_backup`，已 ACK 与未 ACK 的 `ark_checkpoint` 都会留下。`backup-status.json` 在无成功备份时把 `last_offsite_backup_ms` 和 `offsite_age_ms` 写成 null；`cycle-status.json` 的 `connected` 只表示 list 阶段连通。

需要改写的现有句子只有一处事实过满：T2 对 `ark_checkpoint` 在 `verifyRows` 里直接返回，正文行数没有核对。ACK 只比对 manifest 上的 `record_count`。

## 1. 同事务 current+outbox 与幂等

判定：**部分正确。** `accept()` 已有 `BEGIN IMMEDIATE`，duplicate 在写 current 之前返回，事务边界选对了。第 7 行写成「同事务更新 current 和待归档表」，和第 7 行后半「噪声不单独刷历史」叠在一起，会被做成每次 accept 都插入 outbox。

`accept()` 今天不经过 `mutate()` / `withStorageAdmission`。配置库的锁顺序是 config → Ark，且持锁期间不能做等待。留档开关在 `config-store` 的 flag 里，不在 Ark 库。

幂等必须沿用现有 duplicate，不能另加 `snapshot_id` 唯一索引。同一 `grant_id` 下，新 boot 且 `boot_started_at_ms` 更大时，现有规则允许再次 accept 同一个 `snapshot_id`。第 31 行要求 grant/clock/stale/conflict 不改。唯一索引会把这种接受滚回去。

修正文句：

> 每次进入非 duplicate 的 accepted 分支时，在现有 Ark 连接的同一 BEGIN IMMEDIATE 中更新 ark_current。archive 开关和 spool_limit_bytes 在 BEGIN 之前读入参数；accept 内部不再打开配置库事务。需要留档时，同一事务插入一行 outbox；不需要时只提交 current。插入失败则 ROLLBACK，不能留下已接受但缺少 outbox 的应留档版本。duplicate 分支保持现在的提交方式：不插入 outbox，返回原来的 received_at_ms。不新增 snapshot_id 唯一索引，不改变 grant、clock、stale、conflict。内部序号用 outbox 的 INTEGER PRIMARY KEY AUTOINCREMENT，与 snapshot.sequence 分开。正文是 canonicalJson 的原文字节，body_hash 是这串 UTF-8 的 sha256。关档、纯噪声、以及已清理后的重放，都不补历史。「可核对」只覆盖当时策略要求留档、且未过 T3 的 90 天已 ACK 保留期的 accepted 版本。

## 2. 容量 503 不改 latest

判定：**部分正确。** 「应留档才拒绝、旧 latest 不变、差 1 字节 / 正好 / 超过」这个目标对。现有 `STORAGE_CAPACITY_LIMIT` 在 `routes.ts` 的 `onError` 里是 409，只管授权名额。缓冲满若复用这个错误，设备会拿到 409。未命名的异常今天会变成 `ark_dependency_unavailable`，没有 Retry-After。

`/state` 在调用 `accept()` 之前就计入 12 次/分钟。这条保持不动。

故障矩阵把「NAS 离线、NAS 预算满」和「503 不能同时更新 latest」写在同一行。设备路径若直接查 NAS，就违反同文「绝不等待 NAS」。本地未发出的正文仍占预算，所以 NAS 停住之后，本地预算最终仍会以 503 挡住应留档快照。

修正文句：

> 缓冲只使用现有常量 spool_limit_bytes（8GiB），按尚未删除正文的 outbox UTF-8 字节合计，包含已映射但未 ACK 的批。先做现有的 duplicate、stale、conflict、clock、grant 判定。只有本次确实要插入 outbox，且合计加本条正文大于预算时，才在写入前 ROLLBACK：ark_current 保持旧行，/state 返回 503，error 为 archive_buffer_full，Retry-After 为 60。合计等于预算则接受。duplicate 在预算已满时仍返回 200。5 分钟内只含噪声、因而不留档的 accept 不占预算，预算满时仍按旧规则更新 current。STORAGE_CAPACITY_LIMIT 继续只表示授权名额，状态码保持 409。NAS 离线、NAS_BUDGET_EXCEEDED 和 SSH 失败只让导出器稍后重试同一批；/state、preview、语音查询不访问 NAS。

## 3. 5 分钟 / 关键变化判定

判定：**不正确，直到收成一条谓词。** 第 7 行的立即留档列表，少于第 31 行点名的字段。第 31 行还有 `logical_day`、`null` 与 `0` 不同。`timer_state` 两处都没写。间隔的时钟基线也没写；若用 current 的 `received_at_ms`，噪声更新会把 300000ms 窗口不断推后。

修正文句：

> 比较对象是同一 grant_id 的上一条 outbox 快照，不是中间只更新过的 current。没有上一条时，开启留档后的第一条 accepted 必定插入。时间窗用本次 accept 传入的 now 减去上一条 outbox.received_at_ms，大于等于 300000 才因时间插入；299999 不插，300000 插。噪声更新 current 不重置这个起点。与上一条做严格不等（null 与 0 不同）：wallets.family_coin、wallets.stardust、inventory["M-CARD-001"]、progress.next_reward 的 status、kind、item_id、stage_id、progress.claimable_count、source_mode、content_version、config_revision、logical_day。任一变化立即插入。captured_at_ms、received_at_ms、remaining_seconds、timer_state、boot_id、boot_started_at_ms、sequence 不单独插入。第 7 行与第 31 行以本段为唯一规则。

## 4. owner / epoch / GM

判定：**部分正确。** `ark_grant` 的主键是 `sn`。`authorize()` 和 `configure()` 在 epoch 或 account 变化时删除 `ark_current`。outbox 若只存 `grant_id` 再回连 `ark_grant`，换绑后旧 epoch 会丢，或连到新 owner。`source_mode` 今天是快照枚举，服务端没有单独的 GM 鉴权。

设备历史不必新开路由。现有 `historySchema` 是观测事实，不是检查点日志。

修正文句：

> outbox 插入时写上 sn、account_id、epoch、grant_id、source_mode，之后不回连 ark_grant。authorize 与 configure 删除 ark_current 时不删除 outbox，也不给 outbox 加级联删除。读取和验收按 account_id、epoch、grant_id、source_mode 过滤；一批 JSONL 可以包含多个身份，每行自带这些字段。不为 50 个身份或 normal/gm/unknown 各建一条队列，不新增 GM 登录，不新增设备历史路由，不把检查点写进 historySchema 或 preview。换绑、grant 失效和以后的核对都不写回 ark_grant，不恢复旧授权。source_mode 隔离是行过滤：normal、gm、unknown 互不返回。

## 5. 持久 batch 映射与 ACK 丢失

判定：**不正确，若保留「Spool.publish 或 publish_prepared」。** `Spool.publish` 每次执行 `uuid.uuid4().hex`，并复制文件。`publish_prepared` 才接收调用方已经持久化的 manifest；目标已存在且 manifest 相同则原样返回。文档写明调用前要持久化这份 manifest。空文件不能发布：`validate` 要求 `bytes > 0`。`Spool.ack` 与 NAS `acknowledge` 都不删除源，重复 ACK 返回已存 receipt，未知 id 失败。`busy_timeout=15`，导出器若在 Ark 事务里做 fsync 或 NAS，会把设备 accept 打成 503。

修正文句：

> 不调用 Spool.publish 做可重试批次。导出器是 apps/server 里的一个脚本，打开同一个 Ark sqlite。映射事务只做这几步：按 seq 领取 batch_id 仍为空的已提交行，上限 1000 行或 1MiB 正文，先到为止；写入 batch 与 batch_id；提交。文件放在 spool 根下与 backup-work 并列的 ark-work，不碰 ready.json 和 snapshot.sqlite3。库锁外按 seq 写成 JSONL（每行是已存 canonicalJson 加换行）并 fsync。然后把不可变 manifest 写回该批：archive_id 为 32 位 hex，外加 sha256、bytes、record_count、created_at_ms、source_range。之后只调用 publish_prepared。崩溃后复用这份 manifest 和这个 batch_id，不换新包。publish_prepared、NAS prepare/finalize、ACK 都在 Ark 事务外。精确的 archive_id、sha256、bytes、record_count 都一致，且映射行数等于 record_count、等于 JSONL 非空行数时，才删除这些行的正文。保留 seq、snapshot_id、body_hash、sn、account_id、epoch、grant_id、source_mode、archive_id。删除按这组键幂等。空批不发布。不用单个时间戳高水位判断成功。

## 6. JSONL 与 NAS 复用

判定：**部分正确。** `kind=ark_checkpoint` 已在 `KINDS` 中。`source_range` 只要求是对象，manifest 仍是现有八字段且不超过 8192 字节。旧占位包使用 `{}` 或 `{tables:...}`，载荷可以是 sqlite；`verifyRows` 对非 `analytics_backup` 直接返回。保留测试 `storage-nas-retention.test.mjs` 会 finalize 这种 ark 包。新检查必须由 `source_range.format` 打开，否则这些包会开始失败。

`restoreCheck` 会把载荷复制到 `latest.sqlite3`。JSONL 不能走这条路径。SSH `list` 今天没有分页参数；T3 不改这条语法。`queue()` 已有 20 条上限。

90 天删除与后文「T4 再做 90 天/180 天滚动容量」要拆开。T3 只做已 ACK ark 包的固定 90 天删除，避免目录无限增长。180 天、副本、公式和吞吐仍是 T4。

修正文句：

> T2 对 ark_checkpoint 只保证 payload 的 sha256 和字节数；ACK 里的 record_count 只与 manifest 相等，不表示正文行数已核对。T3 的 source_range 仅为 {"format":"ark_jsonl","format_version":1,"lines":N}，不含路径。manifest schema_version 保持 1。storage-nas-verify.mjs 仍只使用 Node 内置模块。verifyRows 仅在 kind 为 ark_checkpoint 且 format 为 ark_jsonl 时核对：非空行数等于 record_count、等于 lines；每行 JSON 的顶层键与 snapshot v1 一致，schema_version 为 1，source_mode 属于 normal、gm、unknown。失败则不 finalize、不 ACK。没有 format 的旧 ark 包继续只查哈希和字节。不要把 ark JSONL 送入 restoreCheck，不要写 latest.sqlite3，不要恢复 grant。T3 的 GC 只删除同时满足已 ACK、kind 为 ark_checkpoint、created_at_ms 早于 90 天的包，走现有 trash 与 receipt；未 ACK 不删；不加入日周 7+4 轮换。查询用 sqlite LIMIT 和现有 queue() 的 20 条。SSH 的 list 命令保持原样。180 天滚动、副本、公式和净吞吐留到 T4。

## 7. 关闭状态兼容

判定：**部分正确。** `archive_enabled` 的类型和 `readStoragePolicy` 都写死为 false。`parseStorageChange` 只允许 `expected_revision` 与 `target_devices`；多带 `archive_enabled` 会 400，已有测试覆盖。`saveStoragePolicy` 用现有 revision CAS，且不改设备开关。GET 固定返回 `archive: {state:"not_implemented", enabled:false}` 和 `device_config_changed:false`。

把开关塞进现有 PUT，会直接破坏「关闭时旧返回值相同」和「改规划数不得变成设备开启」。`readStoragePolicy` 必须与写入同一批改掉，否则持久化的 true 会被读成 `INVALID_STORAGE_POLICY`。

修正文句：

> 默认 archive_enabled 仍为 false。现有 PUT 仍只接受 expected_revision 与 target_devices，请求体里出现 archive_enabled 继续 400。另加一个只修改 archive_enabled 的 CAS：比较同一 revision，成功后 revision+1，不改 target_devices，不写 verified profile，不调用 authorize。关闭时 GET 仍是 archive.state=not_implemented、archive.enabled=false、device_config_changed=false，不增加字段；accept 的状态码和响应体与现在相同，不插入 outbox。开启只决定服务端是否写 outbox 以及导出器是否跑。readStoragePolicy 同时接受 true 和 false；archive_interval_sec、spool_limit_bytes、nas_budget_bytes 仍必须是现在的 300、8GiB、1TiB。设备配置不因规划数字或该 CAS 从 false 变为 true。

## 过度工程化

未要求新增组件。实现停在这些现有入口：

- Ark 库两张表：`outbox`、`batch`
- `accept()` 内的条件插入，以及 `/state` 上一个 503 分支
- 一个导出脚本，只调用 `publish_prepared`
- `verifyRows` 的一个 format 分支，加一段 90 天 ark GC
- policy 上一个独立布尔 CAS

不建消息队列、不拆数据库服务、不做设备 OTA、不做 GM 账号体系、不改 SSH `list`、不把 NAS 同步放进 HTTP。

## 文件 SHA-256

路径相对仓库根。哈希覆盖全文件。片段列是实际阅读范围。

| SHA-256 | 字节 | 阅读 | 文件 |
|---|---:|---|---|
| `9b9792498e26b95b6179e6389393437f83bae284b01a45d5a2ec11bf9adf465b` | 5760 | 全文 | `docs/prnas-storage-50/t2-complete/T3_HANDOFF.md` |
| `6d6dd979f261d067d75d2351cf13d031e4192a3374e35d61fb3b61563f7ba310` | 6385 | 全文 | `2-Projects/P003GameDemo20260513/apps/server/src/ark/store.ts` |
| `1913f8ef4b18ea9dd732f2049263e7ab732335315f8292d26cb7b7490e20496f` | 5796 | 全文 | `2-Projects/P003GameDemo20260513/apps/server/src/ark/contracts.ts` |
| `4c309a2602fb02d705e884b9f5c70453ed21aa5c21affb38c1bab468f668a118` | 4697 | 全文 | `2-Projects/P003GameDemo20260513/apps/server/src/ark/routes.ts` |
| `b7f4c6fd7845aa01bcb274628e079e06958959577a282fd74a417a844560aa1c` | 3088 | 全文 | `2-Projects/P003GameDemo20260513/apps/server/src/storage/policy.ts` |
| `5e67b76ed20e9d882ffb52715a1c04ac41bde70dfd7bea8fcf32254ad61a920b` | 1386 | 全文 | `2-Projects/P003GameDemo20260513/apps/server/src/storage/routes.ts` |
| `d782dd5708cdeb0ed12629d8b3e6535306b9839da2917921527966cb2185e8fe` | 11569 | 全文 | `2-Projects/P003GameDemo20260513/apps/server/scripts/storage-archive.py` |
| `c2028fecac834adbae196fcb3460b25bf1069a0160ec29f693d13c6ebba11e09` | 15029 | 全文 | `2-Projects/P003GameDemo20260513/apps/server/scripts/storage-nas-verify.mjs` |
| `5e61efcb141ca6831b4ee64d8e88b1374d6b338c9c0548db1ced7c2b596d20db` | 6936 | 1–80 行 | `2-Projects/P003GameDemo20260513/apps/server/scripts/storage-backup-job.py` |
| `77dabe972a3209ea9bf721f770348f2b9a8c35c4246c3a80eb74cbbd29530306` | 3661 | 1–40 行 | `2-Projects/P003GameDemo20260513/apps/server/scripts/storage-nas-retention.test.mjs` |
| `a603f3c3e8ee39a720ac1a0df182437b80f92c8c1909bb744dacb73c9d4515d5` | 27169 | 210–259 行 | `2-Projects/P003GameDemo20260513/apps/server/src/config-store.ts` |
| `bd846770e376ec0b61162c69ffa7691a208f52502eaadae57ddd4666e566926d` | 5165 | 30–43 行 | `2-Projects/P003GameDemo20260513/apps/server/src/analytics/contracts.ts` |
