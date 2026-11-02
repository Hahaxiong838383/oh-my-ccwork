# P003 G2 v374 方舟状态同步 Android 回执

日期：2026-11-02（CST）。

## 结论

v374 已完成客户端源码、正式 APK、真机持久队列与真实服务端 `200 accepted` 验证。v373 暴露的「每 5 秒新快照取消并重排 10 秒上报」饥饿问题已修复：调度器保留最早到期任务，只允许凭据恢复等更早任务提前执行。

当前真机存档是 GM 完成档，客户端正确上报 `source_mode=gm`。这证明来源诚实、队列和上报闭环正常，但不能冒充「真实普通用户数值问答」已验收。

## 版本与构建

- 代码分支：`codex/g1-settings-ui-20260915`
- 产品源码提交：`32c20cbf960f6f8e7a219e3f49b7d0919d04cdc9`
- APK：`374 / 1.2.2-canary.360`
- APK 字节：`85,239,578`
- APK SHA-256：`560549d0579bc4bc9cc46104f12bb5a2ebe7cde4ff8fd16a2c1cb456a11e6932`
- 本地产物：`D:/ChatGPTProjects/_codex-temp/p003-g1/v374-ark-state-20261102/local-formal-attempt1/FuturusLauncher-v374-32c20cb.apk`
- 基础 PCK SHA-256 保持：`8ed5066137550ebdd894d1bb33e6caf6db8979d405aae04ec775a76775bea305`
- 门户任务 `bcc66dfe77b34d209d8f4c080f561416` 因 Git 拉取终态失败，未使用旧代码；按正式流程从精确已推送提交本地回退构建成功。

独立验包：v3 签名有效，16K ZIP 对齐通过，包名、versionCode/versionName、Ark Android 四模块、`/v1/device/ark/state`、`ark.state.update` 与不饥饿调度标记均在成包内。

## 真机证据

保数据 `adb install -r` 覆盖安装成功，未卸载、未清存档、未动绑定/凭据/Wi-Fi。

| 项目 | 结果 |
|---|---|
| 版本回读 | `374 / 1.2.2-canary.360` |
| Launcher 六服务 | `6/6` |
| 网络 | `VALIDATED` |
| Fatal / ANR | `0 / 0` |
| 快照边界 | Godot `5200.0 / 7.0 / 0.0` 按数值等价整数接受，`invalid_snapshot=0` |
| 快照来源 | `source_mode=gm`，未伪装 normal |
| 上报饥饿 | 连续约 5 秒入队下，10 秒上报仍稳定触发 |
| 服务端回执 | 多轮 `status=accepted`，每轮最终 `pending=0` |

代表时序（仅记录请求后缀，不记录凭据或完整身份）：

- 15:26:20：连续快照后 `ark_upload_attempt`，随后 `ark_uploaded status=accepted pending=0`。
- 15:26:34：第二轮 `accepted / pending=0`。
- 15:26:49：第三轮 `accepted / pending=0`。
- 15:27:32、15:27:43、15:27:53、15:28:03、15:28:16：持续队列压力下均按期执行并清队。

原始现场保存在 `D:/ChatGPTProjects/_codex-temp/p003-g1/v374-ark-state-20261102/device-validation/`。文档不收录 Bearer、Token、完整云身份或 USB/ADB 序列号。

## 自动验证

- Ark Python 合同：4/4。
- Ark Kotlin 定向：5/5，包含「连续快照不能延后最早上报」和「凭据恢复允许提前」。
- 精确提交 canonical quick：`PASS_WITH_KNOWN_DEBT`，新增失败 0，既有 5 项架构债务未扩大，源码在验证期间稳定。

## 待服务端/人工收口

1. 在用户允许的普通非 GM 存档上获取 `source_mode=normal` 快照。
2. 服务端预览与同轮 Runtime 数值对账。
3. 真人询问家族币、星尘、补勤卡和下一奖励，分别记录 ASR、服务端回答与 TTS 实听。

上述外部条件完成前，v374 结论是「客户端及真实上报闭环 PASS」，不是「个人数值语音问答全链路 PASS」。

