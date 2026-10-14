# P003 Analytics 单机联调客户端回执

日期：2026-10-14（CST）  
范围：云端 MCU / Device Bearer `sub` 末 8 位 `03800006`；不记录完整 SN、凭据或 Token。

## 1. 回执包校验

- 服务端包：`P003-Analytics-单机联调回执-20261014.zip`
- ZIP SHA-256：`0a928c1ecfc8c9e2044b07e78326924b7e628095fb9ed5b41dc351006ca8b3ea`
- 包内 Markdown / JSON 与 `SHA256SUMS.txt` 逐项一致。
- 服务端窗口：2026-10-14 18:00 CST 到期自动关闭，仅放行 `03800006`。

## 2. 首轮真实对账

| 项目 | 结果 |
| --- | --- |
| 构建 | v325 / `1.2.2-canary.311` |
| 服务端批次 | 13 批，全部 HTTP 200 |
| 服务端结算 | accepted=2408，duplicated=0，rejected=27 |
| 设备终态 | 2026-10-14 11:46:20 重启审计 `pending=0` |
| RID | 真机发出与服务端实际入库前缀均为 `ana-03800006-`；本轮未单独留存 ACK 回显原文 |
| 旧窗口关闭 | 服务端已证明定时关闭成功；关闭时队列已排空，本轮无法用实际 pending 证明“关闭期间保队” |
| 显式恢复 | 部分通过；v326 进程启动后首次读到 `enabled=true` 可同日续传；同进程的服务端 false→true 切换尚待受控轮复验 |

`2435 - 2423 = 12` 与旧快照后、上传前继续产生本地事件的时间差一致。服务端 settlement=2435，设备最终 pending=0，当前无丢失或重复入库证据；由于当时未留存这 12 条的逐事件快照，不对具体事件来源做超出证据的断言。

## 3. 27 条拒绝终态

安装 v326 后从保留的 dead-letter 表读取脱敏聚合，未输出属性正文：

| event_name | reason | count |
| --- | --- | ---: |
| `g1.reward_granted` | `invalid_properties` | 11 |
| `g1.inventory_changed` | `invalid_properties` | 9 |
| `g1.experience_started` | `invalid_properties` | 4 |
| `g1.ecotank_selected` | `invalid_properties` | 2 |
| `g1.route_day_selected` | `invalid_properties` | 1 |

合计 27，全部已移出 durable pending，不会重试。服务端不保留被拒绝正文，旧客户端也只保留受控原因，因此不冒称已知具体字段。这 27 条在联调前已长时间累积于本地，但现有证据不足以把其全部定性为“预期历史测试数据”。v326 安装前新增的 19 条当前流程事件已全部 accepted，但不能由此冒称上表五类当前形状均已覆盖。这五类事件仍需在混合 ACK 轮逐项复验。

## 4. v326 客户端修复与真机证据

- 版本：`326 / 1.2.2-canary.312`
- APK SHA-256：`5089c9e7805140d048d87721cbbd963c1312050dcf876bd3520d9c19507d5ee5`
- 修复：平时新事件仍按北京时间每日一次；服务端开关 false→true、凭据恢复、已启动批次退避到期时，立即续传已有队列。
- 审计：启动时只记录 dead-letter 的 event_name / reason / count，不记录 properties、完整 SN 或凭据。
- 测试：Launcher payload 1089/1089，Rust 147/147，正式 APK 签名/重复类/元数据通过。
- 真机：12:15:07 远程配置恢复后同日立即发起 `ana-03800006-1a3fa379-1`；19 accepted、0 duplicated、0 rejected，pending=0，随后记录 daily complete。

## 5. 请服务端开启下一轮

客户端已就绪，请回复实时制的注入起止时刻，按下列顺序：

1. 同 `client_event_id` 重放；
2. 合法事件 + 未登记事件 + 非法 level 的混合 ACK；
3. 429（带 Retry-After）；
4. 503 `ANALYTICS_WAL_PRESSURE`；
5. 500；
6. 403；
7. master gate / 设备开关关闭与恢复。

每轮客户端将保留原队列，按 Retry-After 自动恢复，不忙循环、不人工 flush、不绕过退避。401 继续单独预约，不与上述故障并行。

## 6. 当前结论

正常积压、ACK 三分区结算、终态移队、云端身份/RID 口径以及进程启动后的同日显式恢复已通过。关闭期间有 pending 时的保队、同进程 false→true、受控重放、混合 ACK 和故障注入尚未执行，当前不标记“全项联调通过”。
