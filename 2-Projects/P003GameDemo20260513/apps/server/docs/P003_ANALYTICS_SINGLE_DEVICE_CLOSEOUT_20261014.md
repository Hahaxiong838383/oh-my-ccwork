# P003 埋点单机联调阶段收口回执

日期：2026-10-14；下列时间均为北京时间（CST）。

**结论：客户端回执与服务端结算无矛盾，本轮正常积压上传、三分区结算和终态移队可以阶段收口。单机窗口已于 13:44:02.941 提前关闭，真实数据保留。完整受控联调尚未完成，不标记为全项通过。**

## 1. 回执复核

输入：[客户端原始回执](P003_ANALYTICS_SINGLE_DEVICE_CLIENT_RECEIPT_20261014.md)，原字节归档，SHA256 `0f96953c7e6ecbd4ea173bbaf65f94792da516d9aa37667103e4d3f7c0422a48`。

| 项目 | 复核结果与证据来源 |
| --- | --- |
| 云端身份 / RID | MCU/JWT sub 末 8 位 `03800006`；真实入库 RID 均以 `ana-03800006-` 开始，与本次客户端回执一致 |
| v325 首轮 | 服务端 13 批均 HTTP 200；accepted=2408、duplicated=0、rejected=27，与客户端回执吻合 |
| 客户端首轮终态 | 客户端报告 11:46:20 重启审计 pending=0；27 条拒绝已移入 dead-letter、退出 durable pending，不再重试。此次未直接读取设备数据库 |
| 27 条拒绝分布 | 客户端脱敏聚合：reward_granted 11、inventory_changed 9、experience_started 4、ecotank_selected 2、route_day_selected 1，合计 27；服务端拒绝类别同为 invalid_properties |
| 旧积压差额 12 条 | 2435−2423=12 与统计间隔中继续入队一致；没有逐事件快照，不对具体来源或“全部预期测试数据”作断言 |
| v326 后续上传 | 服务器确有 `ana-03800006-1a3fa379-1`，12:15:08.688 接收，HTTP 200，19 accepted、0 duplicated、0 rejected；与客户端报告 12:15:07 配置读取后发起上传吻合 |
| 显式恢复边界 | 客户端报告 v326 启动后同日续传和 pending=0；同进程 false→true、关闭时有 pending 的保队仍未受控验证 |
| ACK 回显 | 身份与实际请求前缀已对齐，客户端未留存首轮 ACK 回显原文；不补造该项通过证据 |

27 条具体非法属性字段未知，五类事件当前合法形状也未全部覆盖。拒绝终态处理已确认，不等于这些数据的业务格式问题已修复。

## 2. 最终服务端对账

13:43:13.235 关闭前只读核验、13:45:26.422 关闭后复核：

| 指标 | 收口值 |
| --- | ---: |
| 批次 | 14（首轮 13 + v326 后续 1） |
| accepted / 原始表 / seen | 2427 / 2427 / 2427 |
| duplicated | 0 |
| rejected | 27，全部 invalid_properties |
| settlement | 2454 = 2427 + 0 + 27 |
| 新增测试事件 | 0，关闭探针为空批 |

## 3. 关闭与保护结果

- **13:44:02.941 完成提前收口**：master=false、目标 upload=false、daily hour=0、独立 allowlist=0，窗口 state=closed、owner 已释放。
- 公网完整配置返回 200、`cfg-19`、analytics false/0，posture 保留；14 台注册设备有效上传配置均 false，非目标配置哈希保持。
- 有效目标凭据的公网空批上传返回 503 `ANALYTICS_UPLOAD_DISABLED`，`Retry-After: 900`，验证关闭态；没有插入事件。
- 原 30 分钟窗口和延长窗口的两个专用 timer 均已停止并禁用。原计划 18:00 已取消；这是提前人工收口成功，不能写成“18:00 已实际自动关闭”。保留单位文件、脚本、state 与私有关闭回执，其他维护/备份任务未操作。
- 原始数据、WAL、seen、HMAC 与私有恢复原件保留，没有回退整库、清队列、重装设备或主动注入错误。
- 仅 analytics 重启为 PID3122854/restart4；公司主服务 PID2817417/restart23、个人主服务 PID1626403/restart0 保持。关闭后 ready=true、gate=false、allowlist=0，无 WAL 压力。

## 4. 后续专项联调

本次用户指示收口，客户端文档中申请的下一轮不在本次执行。以下项目按未完成保留，后续另约单机受控窗口：同 ID 重放、受控混合 ACK 与五类拒绝事件逐项复验、429/Retry-After、503 WAL pressure、500/403、有 pending 时关闭保队、同进程 false→true、单独 401，以及真实午夜调度。

v326 客户端签名/构建、1089/1089 Launcher 与 147/147 Rust 结果为客户端提供的证据，本次没有重跑端侧测试或独立核验安装包。历史小可语音不回复仍待自然复现，不因本轮埋点收口改为已解决。

机器可读结果见[收口 JSON](P003_ANALYTICS_SINGLE_DEVICE_CLOSEOUT_20261014.json)。此前已发送的服务端回执与 ZIP 保持原字节，本收口文件作为新的最终状态记录。

署名：codex（OpenAI）| 2026-10-14
