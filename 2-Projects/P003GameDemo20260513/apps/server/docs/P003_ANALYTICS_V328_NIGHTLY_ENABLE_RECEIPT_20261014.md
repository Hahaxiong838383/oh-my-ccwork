# P003 v328 单机每日 23:00 上传启用回执

日期：2026-10-14；以下时间均为北京时间（CST）。

**结论：服务端已于 17:22:31.095 开启单机持续上传。目标仍为云端 MCU / Device Bearer sub 末 8 位 `03800006`，下发 true/23；17:23:00.886 已收到该设备真实补传 146 条，全部 accepted。今晚 23:00 自动调度尚待真实到账取证。**

## 服务端生效值

| 项目 | 当前值 |
| --- | --- |
| 公网入口 | `https://kidshub-ai.hahaxiong.cc/v1/device/` |
| Analytics master gate | true |
| 独立 Analytics allowlist | 仅目标设备 1 台 |
| 目标配置 | `analytics.event_upload_enabled=true`、`analytics.daily_upload_hour_cst=23` |
| 公网配置版本 | `cfg-21`，完整配置 GET 200 |
| 其他设备 | 其他 13 台注册设备有效上传均 false；抽样公网配置 false、上传请求 403 |
| 全局配置 | 保持 false/0，只有目标 SN 覆盖为 true/23 |
| 持续时间 | 持续每日策略，无本次自动截止；关闭须另行执行本次恢复步骤 |
| 原关窗任务 | 两个旧窗口 timer 均 inactive/disabled，原 18:00 计划保持取消 |

此次按用户请求立即启用。客户端首次获取 true/23 时可先补传旧积压；已观察到的 146 条属于此次开启后的真实上传，不是今晚 23:00 自动触发证明。日常 23:00 调度由客户端执行，服务器持续允许该目标上传，没有按小时拒绝合法补传。

## 公网准入与真实对账

- 17:22:31 启用后，目标短时有效凭据空批返回 400 `INVALID_BATCH`，证明通过身份、总闸和目标范围后进入数据校验；非目标 active 设备空批返回 403 `ANALYTICS_DEVICE_NOT_ENABLED`。探针 events=[]，未注入事件。
- 17:24:53.367 独立只读复核：cfg-21 true/23、gate=true、allowlist=1、ready=true、无 WAL 压力、storage_failures=0、sql_busy=0。
- 真实批次：`ana-03800006-8c9f3f3c-8`，17:23:00.886 入库，HTTP 200，accepted=146、duplicated=0、rejected=0。
- 开启前为 14 批、accepted/raw/seen=2427、rejected=27、settlement=2454；上述复核时累计 15 批、accepted/raw/seen=2573、duplicated=0、rejected=27、settlement=2600，符合 `2573+0+27=2600`。历史 27 条拒绝未被删除或重新标记为通过。
- 公网配置探针使用服务器内存短时凭据；真实补传批次来自设备上传。两种证据分别记录，不将探针视为真机配置应用或安装包版本证明。

## 变更与恢复

仅调整目标的两个配置键、独立名单和总闸。非目标配置哈希与 posture 保持；.env.analytics 除 Analytics allowlist 外原字节一致。仅重启 analytics 为 PID3192914/restart5；公司主服务 PID2817417/restart23、个人主服务 PID1626403/restart0 保持。

本次私有操作目录：`/opt/p003/server/backups/analytics-policies/nightly-20261014T091950Z-03800006`。原 env、总闸、配置、state、启用回执、独立验证和恢复步骤保留，目录 0700、原件 0600；操作脚本 SHA256 `700a3139a57cde5ee22bbb49f63c8afac24f15bb8a1b5d66b002c108ce3871f5`。

关闭顺序为：先总闸 false，再目标上传 false、恢复原 hour=0、独立名单清空，普通重启 analytics 后读回关闭态。确认 owner 与脚本 SHA 后，在 `/opt/p003/server` 执行以下关闭命令：

```bash
/opt/p003/server/.runtime/node-v24.19.0-linux-x64/bin/node \
  --experimental-sqlite --env-file=.env.local --env-file=.env.analytics \
  backups/analytics-policies/nightly-20261014T091950Z-03800006/operator.mjs close
```

保留最新 DB/WAL/seen/HMAC，不恢复整库或清客户端持久队列。

## 端侧联调回传口径

端侧确认本机应用 cfg-21 的 true/23；本轮实际 pending 尚未收到客户端回执。后续提供实际版本/配置应用时间、RID、各批 accepted/duplicated/rejected、pending 和 dead-letter 结算。今晚 23:00 附近核正常定时触发，并区分首次历史补传、失败重试与正常日常上传。

v328 准备完成和本地持久队列为端侧反馈，本次未独立核验 APK 或安装版本；重放、混合 ACK、受控 429/503/500/403/401、带 pending 关闭保队、同进程恢复及午夜专项未扩大为已通过。小可语音间歇不回复仍按此前约定等自然复现。

机器可读原始结果见[P003_ANALYTICS_V328_NIGHTLY_ENABLE_RECEIPT_20261014.json](P003_ANALYTICS_V328_NIGHTLY_ENABLE_RECEIPT_20261014.json)。此前 13:44 收口回执是历史阶段记录，原字节保持；本文件记录新授权开启后的最新状态。

署名：codex（OpenAI）| 2026-10-14 17:26 CST
