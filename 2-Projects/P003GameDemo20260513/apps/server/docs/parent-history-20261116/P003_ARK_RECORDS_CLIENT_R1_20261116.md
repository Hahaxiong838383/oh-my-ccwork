# mini009 真实业务明细 · 端侧实现与服务端候选合同 R1

日期：2026-11-16。仅小程序独立分支 `codex/g1-miniapp-ble-provisioning-20261028`，版本 `371_mini_009` / versionCode **371**，不是主版本占号。本文取代前一需求回执中“端侧尚未实现”的状态，但**不表示服务端接受或上线此新增合同**。用户要求本轮不上机；保留设备、绑定、凭据、队列。

## 1. 已实现与边界

Rust Runtime 在业务状态变更时，同一 StateStore 原子提交生成不可变的业务事实：钱包 before/after/delta、真实 RewardLedger 新入账、库存获得/状态改变、按生态缸发卡与补勤消耗。Godot 仅交接这些事实；原生独立 SQLite 入队成功后，下一次桥接才返回可删除 ID，Rust 精确 ACK 后持久删除本地交接副本。HTTP 成功不等于业务 ACK；服务器确认前原生仍保留数据。任一存档写入失败不提交候选钱包或记录。

旧 Telemetry、使用时长、Ark 当前快照、夜间 Analytics、BLE 绑定及 401 恢复归属不改变；不向严格的旧 `/v1/device/ark/state` 增加字段。服务端需要实现接收、查询、聚合与小程序页面映射；客户端不做任务 CRUD、家长兑换发币、KidsHub 或视光报告等服务端产品。

## 2. 网络开关：默认关闭

仅在既有设备 config 收到以下精确对象后开启新通道；其他/缺失/字符串布尔/未知合同均不请求新接口。原生本地记录与交接不依赖开关。

```json
{"ark_records":{"enabled":true,"contract_id":"p003-ark-records-r1"}}
```

这不是要求服务器立即下发。请先回签下面 wire；若需改路径或 ACK 字段，双方出新修订后再启用，不原地漂移，不在旧服务器上猜接口。未下发时原 Telemetry 和 Ark 照常工作。

## 3. 记录与批次

候选 POST `/v1/device/ark/records:batch`；沿原 Device Bearer（不新增刷新接口）。URL 只在原生适配器；Godot 不接触 URL/凭据。头 `Content-Type: application/json; charset=utf-8`、`Authorization: Bearer <既有设备凭据>`、`X-Request-Id: arkrec-<随机UUID>`。每次尝试 RID 可变；冻结 batch_id、record_id、发生时刻和内容不变。body 不发送 SN、家长、儿童姓名、Wi-Fi 或 token。

```json
{"schema_version":1,"contract_id":"p003-ark-records-r1","batch_id":"arb-example","save_id":"save-example","coverage_from_ms":1794830400000,"dropped_records":0,"records":[{"record_id":"save-example:2","save_id":"save-example","sequence":2,"occurred_at_ms":1794830400000,"logical_day":"2026-11-16","source_mode":"normal","record_kind":"business_commit","config_revision":"config-example","active_ecotank_id":null,"data":{"wallet_changes":[{"resource_id":"C-FAMILY-001","before":0,"after":100,"delta":100}],"inventory_changes":[],"grants":[],"makeup_grants":[],"makeup_uses":[],"previous_source_mode":"normal"}}]}
```

示例是合成值，不是真实到账证据。JSON Schema 见同目录 `ark-records-r1.request.schema.json` / `ark-records-r1.response.schema.json`。原生只接 Runtime 语义树，固定字段、层深、长度及整型限制；禁止把任意日志/用户输入混入。

| 字段 | 语义 |
| --- | --- |
| save_id / record_id / sequence | 持久独立存档空间；ID 为 `<save_id>:<sequence>`。新档新空间，重启不变；不等于 boot/设备身份/APK版本。序号用于发现缺口，不以到达先后作业务排序。 |
| occurred_at_ms | 端侧真实事务生成的墙钟毫秒；重试不重写，不使用 GM 推演逻辑时间。时钟未知/异常的可信度须服务端保留，不捏造历史。 |
| logical_day | 游戏当前逻辑日，可为 null；补历史奖励的原始归属日另外在 grants / makeup_uses 中保留。 |
| source_mode | normal / gm / unknown；旧档缺证据为 unknown，不冒充正常收入；GM 新事务标 gm，不能洗白。 |
| baseline | 接入时钱包/当前库存基线，`history_complete_before_baseline:false`，绝不是一次收入。库存有原 acquired_at_ms、kind/tank/layer/status，未知为 null。 |
| business_commit | 整笔业务变更；wallet_changes、inventory_changes、grants、makeup_grants、makeup_uses。相同奖励重试不会再制造新流水。 |
| grants | 原 RewardLedger：reward_instance_id、source_kind、source_id、logical_day、resolved_rewards、config_revision、granted_at_ms/status。一笔批量领取可含多个 grant；不能按记录数当奖励数。 |
| inventory_changes | item_id + before/after 完整物品；获得和 pending_activation→active 是不同事实，启用不能当重新获得。 |
| makeup_grants / makeup_uses | 解锁缸发卡的 tank_id；消耗目标 logical_day、usage_day_index、tank_id。库存真实增减为数量真值，不能用“点击卡”计消耗。 |

昨日收益推荐按 normal 记录真实发生日（北京时间）正向钱包 delta 汇总，分别币种；不得按余额差或基线算收入。历史目标日不改真实到账日。最新物品按真实获得时刻/存档序号与当前状态，不按补传到达时间；旧档基线只能支持已知当前库存，不能补造历史。服务端不由这些记录重复发币或覆盖 Runtime。

## 4. ACK 与重试（实际候选实现）

```json
{"ok":true,"data":{"batch_id":"arb-example","accepted_record_ids":["save-example:2"],"duplicated_record_ids":[],"rejected":[]}}
```

终态拒绝行：`{"record_id":"save-example:2","reason":"invalid_properties"}`。仅请求内 ID 可以 ACK，三个集合互斥，错误 batch/外来 ID/重复或矛盾字段/假 ok/空 ACK 均不出队。允许部分 ACK；缺失行保留，仍用原冻结批次重试。重复 ID 同内容再次 ACK；同 ID 异内容拒绝，不能覆盖历史。accepted/duplicated 清正文留 ID+哈希墓碑，rejected 留 dead-letter 正文和原因，不重新发奖。

网络异常/超时/500 保留；429/5xx 使用 Retry-After 秒或 retry_after_ms 与本地指数退避较大值，最长7天；403 至少15分钟。401 仅沿现有通用凭据恢复，自己的恢复后解除自身退避；不新增清绑定或凭据策略。413 将未接受批次减半、新 batch_id、原 record_id；单条超限保留告警/退避。其他 4xx 暂存并至少15分钟退避，**与诊断日志400直接死信不是同一合同**，请服务端确认；不把未冻结接口的拒绝当用户数据已确认。

单请求连接3秒/读取8秒、禁止跟随重定向、响应最多64Ki字符；每次正常请求至少间隔30秒。退避截止写 SQLite，重启不靠内存忘记退避；上传不占主线程，不阻塞游戏/设置/BLE。

## 5. 上限、覆盖和身份限制（必须保留）

- Rust 交接 outbox 2048条；满时保较早未交接事实，新溢出计入持久 dropped_records，游戏不停；**有缺口不得显示完整历史/完整昨日收益**。原生每次最多16条，单条32KiB、交接/HTTP批64KiB。超大条不能静默吞掉。
- 原生独立库最多20000行、保留正文合计8MiB；满时原子拒绝新交接、Rust不删副本，不清旧绑定或队列。墓碑同样占行数；本版不自动压缩墓碑/死信、不宣称无限历史，达到容量需后续受控归档合同。
- coverage_from_ms 表示采集起点；之前历史未知，不显示0。dropped_records 非0、容量/非法数据/时钟问题必须暴露，不以 pending=0 冒充完整。
- 凭据scope按已校验设备身份与凭据epoch散列隔离，旧scope的批次不阻塞新scope；若凭据无epoch，保守使用凭据指纹，换凭据后旧存档明细暂停而不是转交给未知新归属。请服务端确认 epoch 稳定性/迁移办法；本轮不自动重归属或删除旧队列。
- 新档前尚在 Runtime 未交接的内容遵循用户显式游戏清档语义；已经在原生持久化的旧档记录不清除。不同save_id不能合并成连续无缺口收入。

## 6. 合并接线与不可覆盖范围

新增 Rust `g1_business_records`；模型新增 serde default 日志字段，无整档替换/云端恢复。旧档首次真实变更生成基线；正常游戏规则不改。`g1.records.query`只读，`g1.records.ack_durable`只删精确副本。Runtime保存事务强制保障新记录持久性。

Godot 新 `ArkRecordsHandoff` autoload，每2秒查询/交接，验证 inner/outer ok、同save与子集/去重 ID；独立脚本可移植。Android 新 Contracts/Store/Client/Coordinator；Bootstrap、原配置分发及凭据恢复仅最小接线，日志沿现有隔离录制。Bridge新增 `ark.records.exchange`，patch同时支持本mini7路及G2的10路拓扑，缺失/重复锚点失败关闭。无 main.gd、MCU、外接屏、美术、Hall/Presence/语音/OTA归属变更。

移植时整组模块+桥接/构建类闭包+UID一起合入；不得只拣界面或把业务事实降成点击埋点。不要合版本计数/渠道配置/二维码到主线，不覆盖正式分支的其他变动。

## 7. 必须进行的后续三方验收（本轮不上机）

1. C机保留绑定和队列覆盖装mini009，记录实际包/版本；服务端回签R1后单机开关，不全量。
2. 真实正常档：基线不能算收入，领取金币/卡/部件，补历史日、批量领取、重复点击、进程中断，逐 record_id核钱包、库存、ACK及后台/手机。
3. 离线入队重启联网、同批重放、部分/重复/拒绝 ACK、429/503/500/401恢复；原队列不清，不能旁路服务器退避。
4. 换档namespace、未知来源、GM隔离、pending_activation不重获、覆盖起点与缺口展示；到上限保原数据且游戏可用。
5. 原亮度快照两次/心跳/用时/姿态/Ark current/BLE与主业务回归；父端API、聚合及手机页面由对应同事完成真实对账。

自动测试和包证据见最终打包回执；主机通过不等于真机或服务器通过。本文不含设备凭据/完整身份/USB身份。
