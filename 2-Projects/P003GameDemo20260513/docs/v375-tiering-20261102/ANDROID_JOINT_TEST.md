# P003 v375 埋点分层单机联调回执与用例

**状态：服务端候选已完成实现、本地测试及独立隔离复核，待主会话13发布；本文件不是“窗口已开”通知。部署和开窗由主会话13统一确认，请收到实际开始时间/配置revision后再进行设备测试。**

对象：BJP00326070803800006（云端Device Bearer sub须完全一致），v375 / 1.2.2-canary.361；客户端源码52b89ec9，交付4f7cc36。服务器固定功能候选856552b942f5f8c2feb08db5949ebe7080eff77f。不更换APK/PCK、不改其他设备。
沿用当前服务器域名、Device Bearer及接口：GET `/v1/device/config`，POST `/v1/device/analytics/events:batch`；RID前缀`ana-03800006-`。后台：Worker管理 → 数据埋点 → 分层与按需。

## 开始前端侧确认

- 提供实际APK与运行PCK版本、MCU SN/凭据sub一致性、设备北京时间（不发凭据本身）。APK版本不能替代Godot运行能力核验。
- 服务端原上传总闸/单038范围保持；`event_upload_enabled=true`、`daily_upload_hour_cst=23`。新开关初始false，接到服务器通知后分阶段下发。
- 记录配置revision和Launcher/Godot已应用证据；云端保存成功不等于设备收到。

## 按顺序实测

|步骤|服务端配置/操作|端侧动作与通过证据|
|---|---|---|
|1 gzip|仅request_gzip_enabled=true|正常打开/关闭设置产生真实raw；按现有日批/积压规则上传。记录RID、事件ID、数量；服务端核gzip字节、实际持久化和ACK。|
|2 本地分层|tiering_enabled=true且aggregate_upload_enabled=true；period_days固定7|证明Godot收到双开关、12类来源真实进入桶；关键失败/奖励/钱包仍raw。单真不会分层，不能算通过。|
|3 真实周期闭合|保持原日批23点|记桶start/end和count，实际闭合后同一ID一次accepted、重放dup；服务端按接收时间拒收未闭合周期，不修改真机时间加速。7天尚未完成则标待验。|
|4 按需样本|建议22:50～22:55创建60分钟、100条、回溯3天的请求，仅允许settings.opened等必要来源|记录服务端生成的完整request ID及revision；核Godot/Launcher接收和23点实际HTTP。样本request_id位于context，和HTTP RID不同。|
|5 收束|服务器撤销请求/明确关闭capture，其他设置按13通知|端侧收到upload=false、request_id空及新revision；记录队列结算。已经进Launcher的样本不会因关开关自动撤回，撤销后新样本逐条rejected，混批raw继续正常结算。|

按固定7天公式推算，2026-11-02所在周期为北京时间10月29日00:00～11月5日00:00；若期间启用并保持正常运行，首个闭合桶通常等11月5日23点日批，实际以端侧桶边界和调度回执为准。11月2日夜间可先验gzip/按需，不能因没有周期聚合到账就判失败；完整7天节省率仍需连续观察。

**按需不等于立即上传。** v375普通append只入持久队列，单改request ID/gzip/tiering不会强制网络上传；仍受23点日批和既有历史补传策略控制。若当天日批已完成，不能安排当天短窗并期待立即到账；请另约下次日批，确保有效期覆盖上传和重试。不要自行开关总上传或改小时来强制排空。

服务器保留raw14天、聚合90天、诊断样本3天（按接收时间），幂等记录持续保留。聚合count是代表次数，不能当余额/收益/奖励流水。原始正文、录音与令牌不进入回执。

## 对账回传模板

```
测试时间（北京时间）：
完整SN（核对sub一致）：
APK / 运行PCK版本：
设备时间是否正确：
配置revision / 端侧应用时间：
阶段：gzip / 本地桶 / 闭合聚合 / 按需样本
HTTP RID / batch_id：
event_name / client_event_id（仅本次相关ID）：
按需request_id（如有）：
accepted / duplicated / rejected数量及reason：
本地队列前后条数 / 死信reason汇总：
聚合period_start/end/count（如有）：
服务端对应实际入库层与数量 / 后台查询：
普通语音、倾听、搜索、方舟回答有无异常：
结论：已验证 / 部分验证 / 待验证
```

gzip/raw、ACK幂等、授权/限额/TTL和600条非raw不挤占Ark预算由隔离服务端验收覆盖；真实PCK分层、公网压缩、真机语音、实际日批及7天节省率需按本文件取证，不能以本地自动测试替代。

署名：codex（OpenAI）| 2026-11-02 CST
