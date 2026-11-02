# P003 G2 v374 倾听模式＋方舟数据问答同版本收口回执

日期：2026-11-02（CST）。

## 交付结论

v374 已将两项 Android 能力合入同一正式 APK：

1. v371 的小可倾听模式可信提议、本地停音、持续收音、seq/重传、超时查询与新会话恢复；
2. v374 的 Runtime 权威方舟快照、Godot 薄转发、Launcher durable latest-only 队列、设备凭据上报及不饥饿调度。

两者边界独立：倾听模式不读写游戏存档；方舟快照不控制 RTC、麦克风或本地播音；Godot 不持有 ECS URL 和设备凭据。

## 状态矩阵

| 功能 | 客户端源码/自动合同 | 正式包/真机 | 服务端真人闭环 |
|---|---|---|---|
| 倾听模式 | PASS | 服务端未下发新能力时，普通开盖欢迎、RTC 连接、播完关房和 `ready_next_wake` PASS | PENDING：需服务端开启 `listening_voice_control_v1` 后执行 A01–A10 |
| 方舟快照 | PASS | 连续快照多轮 `accepted`、`pending=0`，六服务 6/6、Fatal/ANR 0 | PARTIAL：当前为 GM 档，尚需 normal 档预览与同轮 ASR/TTS 问答 |

## 合并版本

- 分支：`codex/g1-settings-ui-20260915`
- 产品源码：`32c20cbf960f6f8e7a219e3f49b7d0919d04cdc9`
- APK：`374 / 1.2.2-canary.360`
- APK SHA-256：`560549d0579bc4bc9cc46104f12bb5a2ebe7cde4ff8fd16a2c1cb456a11e6932`
- APK 字节：`85,239,578`
- 本地包：`D:/ChatGPTProjects/_codex-temp/p003-g1/v374-ark-state-20261102/local-formal-attempt1/FuturusLauncher-v374-32c20cb.apk`

## 真机兼容结果

- 保存档、绑定、凭据和 Wi-Fi 覆盖安装；未做清数据类操作。
- 开盖欢迎会话返回 `listening_contract enabled=false`，这是服务端尚未开能力时的正确降级；客户端没有伪报进入倾听。
- 开盖欢迎已连接 RTC，播完后以 `opening_announcement_complete` 关闭并恢复下一次唤醒。日志中闭房路径会向 UI 发一个短暂 `error/fatal`状态，随后同毫秒级回 `idle`且 `ready_next_wake=true`；没有进程 Fatal/ANR，这是现有欢迎收房表示，不冒充新倾听会话证据。
- Ark 上报与欢迎/关房并行时未阻塞语音线程；六服务保持 6/6，网络 VALIDATED，Fatal/ANR 为 0。

## 两项功能最终联调清单

服务端开启单机能力和方舟预览后，使用这一个 v374 包完成：

1. 倾听 A01–A10：语音进入、连续讲述、一次反馈、插话、唱歌、语音退出、重复/迟到/错房、断网/授权、负例、旧能力降级。
2. 方舟 normal 快照：普通档真实采样→200 accepted→服务端预览同源。
3. 同一轮真人询问家族币、星尘、补勤卡、下一奖励，核对 ASR、预览、模型回答和 TTS 实听。
4. 上报期间再做一次唤醒/退出，确认不抢麦、不延迟关房。

子回执：

- `reports/P003_G2_V371_LISTENING_VOICE_ANDROID_HANDOFF_20261102.md`
- `reports/P003_G2_V374_ARK_STATE_ANDROID_RECEIPT_20261102.md`
- `reports/test-cases/P003_G2_V371_LISTENING_VOICE_CASES_20261102.md`
- `reports/test-cases/P003_G2_V372_ARK_STATE_CASES_20261102.md`

因此，本次可收口为「同版本客户端交付＋真机 Ark 上报闭环」；倾听新能力和普通档数值回答仍需服务端能力窗口与真人语音，不得把未测写成 PASS。

