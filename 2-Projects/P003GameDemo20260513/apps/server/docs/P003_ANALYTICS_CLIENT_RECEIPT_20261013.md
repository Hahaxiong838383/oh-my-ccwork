# 给P003端侧同事的回执（2026-10-13）

服务端及原Worker管理后台的数据埋点页面已部署，正式入口：

`POST https://kidshub-ai.hahaxiong.cc/v1/device/analytics/events:batch`

沿用当前Device Bearer，完整设备配置保留schema_version/revision/posture，新增analytics字段。当前服务器全局为event_upload_enabled=false、daily_upload_hour_cst=0（北京时间），独立灰度名单为空、服务器总闸关闭；端侧内置默认false/23点不改。

**请继续保持端侧上传关闭。** 14台集中上传测试的P95/P99未达门槛，暂未放行任何采集；不要因接口已上线就打开上传。

当前可联调：完整配置读取、Device Bearer鉴权、关闭状态JSON503与Retry-After=900秒、失败时pending保留及自动恢复退避逻辑。无效凭据401，后台admin可读、editor/guest403，已有数据不因关闭或回滚删除。

服务端容量重新通过后，再约定一台非儿童在用测试机：由服务端仅对该机开灰度/配置/总闸，验证混合ACK、同ID重放duplicated、JWT续签后去重、临时失败恢复及北京时间00点真实夜间补传。该阶段和真实夜间上传目前均未执行。

请端侧特别核实一次“上传局部失败→恢复联网→无需强制flush自动重试”：源码的epoch retry_at_ms与ticks_msec比较有待验证，尚不能认定为已复现问题。

详细批次/ACK/错误与验收步骤见 [联调文档](P003_ANALYTICS_SERVER_INTEGRATION_GUIDE_20261013.md)，测试/部署/容量失败与回滚锚见 [部署回执](P003_ANALYTICS_SERVER_DEPLOY_RECEIPT_20261013.md)。本资料由川哥转交，未自动向同事发消息。

署名：codex（OpenAI）| 2026-10-13
