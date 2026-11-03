# v377 联调：Ark服务端只读准备回执（45）

结论：**目标Ark授权有效、真实快照持续接收；normal钱包问答验收待真实样本，v377尚未包含钱包修复。** 本回执不是联合验收通过。

## 授权水位（独立只读，2026-11-03T12:30:52.358000+08:00）
- 目标MCU/Device Bearer sub尾号：03800006；registry active、对应账号role=device。
- Ark master开启；Ark settings revision=3。此revision不同于设备配置cfg-66。
- 目标在Ark ceiling中；grant账号匹配，grant epoch=identity epoch=3。
- not_before_ms=1793609324433，即2026-11-02 16:48:44.433 CST。当前快照关联同一grant；本轮没有重置授权水位。
- 12:24开窗前和12:26开窗后独立核对，12:30再次只读回查授权，Ark设置、grant、epoch、12份Ark运行源码均未变化；源码与固定856552b9逐字节一致。
- 持久化最新快照收到时间：2026-11-03T12:30:46.028000+08:00；snapshot_id=ark-c89d8f6b7edd4e3c-478，sequence=478，source_mode=gm，双钱包中1项null，逻辑日2026-11-05。不能将GM资产/未来逻辑日当正常用户事实；不能由content_version推断Launcher已装v377。

## 本次窗口
45于12:30只读回查cfg-66、request_id及到期时间，与主13开窗回执核同。主13回执记录 2026-11-03T12:25:50.775000+08:00 至 2026-11-03T23:29:59.775000+08:00，设备配置cfg-66；13是唯一配置写入者。Analytics详细额度/调度与独立对账由13/48回执负责，45不重复开窗。Ark原授权已存在，不等于在本时刻新建grant，也不承诺随Analytics窗口到期自动撤销Ark授权。

## 客户端阻断与补齐
1. exact v377源码35502e7746eed6b5f24e5ba1cfa7d7e263c68a72已读取核验10文件；9份Rust/Godot/Launcher运行源码与未修复v376逐字相同。完整commit compare为2个提交、17个文件，变化为日志导出/构建脚本/文档等，无钱包权威修复。
2. 因此v377可以联调上传、受控日志导出以及“未知值不编造”的行为，但不能宣称known-zero问题已修。已交724559e5补丁在该v377精确源码的私有副本上通过apply检查、实际应用、reverse检查和实际还原；38份原始文件内容及集合核同，**没有合入安卓共享分支或实际包**；安卓需要合入修复并交新的代码锚和正式包证据。
3. 当前整档是GM来源，普通操作或重启不能作为已回normal的证明。保留存档前提下，端侧须先确认是否能提供来源可信的normal样本；若不能，本项保持待验。禁止改标签、服务器改null为0、人工清档/补余额来凑结果。本轮不授权这些操作。
4. 附件称APK仍在构建；45没有安装证据。需要实际versionCode/versionName、代码SHA、APK/PCK哈希、运行内容版本与规则revision，再判包体归属。

## 同一真实快照的最低对账字段
- 端侧：snapshot_id、boot_id、boot_started_at_ms、sequence、captured_at_ms、logical_day、source_mode、wallets、补勤卡inventory、完整progress、content_version、config_revision；仅必要数值，不发存档全文。
- 传输与持久化：HTTP状态、accepted/duplicate/stale等业务结果、received_at_ms、目标尾号、同一grant epoch/水位。HTTP200不单独等于新快照accepted。
- 同轮后台preview：资产值/未知及来源时间；进度同时核captured/received/逻辑日，当前建议新鲜度30秒，暂停不按墙钟递减；重复包不续期。latest-only会被覆盖，应当轮保留脱敏结果。
- 真机问答：真人发起“家族币多少/星尘多少/补勤卡几张/下一宝箱多久”，记录问答时间、trace_id与会话关联、对应快照ID，以及动态问答memory_excluded。45不会触发设备或调用外部模型试验真实数据。
- 真实normal包到达后，45再只读核server preview与实际Q&A；当前仅收到GM，不能提前标通过。钱包余额不是今日收益；下一宝箱不是下一枚金币；null不等于0。

未部署、未改配置/存档/epoch、未制造POST或事件、未触发设备语音；其他设备、23点日批、搜索/倾听保持。本回执可以给端侧同事，固定源和补丁证据见本目录README.md；凭据、完整身份和原始儿童对话不在本文。

署名：codex（OpenAI）| 2026-11-03
