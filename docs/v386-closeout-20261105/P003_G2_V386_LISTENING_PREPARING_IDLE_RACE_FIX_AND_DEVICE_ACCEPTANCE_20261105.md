# P003 G2 v386 倾听 PREPARING 空闲竞态修复与真机验收

## 问题与证据边界

- v385已经证明：服务端退出倾听完成后，Android可立即发布普通`listening`状态，同房普通问答及约5秒无输入关房恢复正常。
- 后续真实复测发现独立竞态：进入倾听提案已接受、控制器处于`PREPARING`时，普通会话遗留的5秒空闲截止时间仍继续计时，可在Worker完成切换前关闭房间。
- 该问题不是退出口令未识别，也不是服务端没有下发退出完成。

## v386 修复

- `PREPARING`期间只冻结普通房间空闲看门狗；不伪造进入完成或UI状态。
- 控制器已有的有界超时与恢复继续负责失败或长时间未完成的切换，不能形成无限僵尸房。
- 稳定切换或退出回到`NORMAL`后清除等待并重新开始完整5秒空闲预算。
- Worker、trace、room、participant SID、epoch、TTL及Ready信任校验保持不变。

## 自动验证

- PASS：`VoiceIdlePolicyTest`定向测试。
- PASS：payload完整JVM测试1781项，failures=0、errors=0、skipped=0。
- PASS：`git diff --check`（待提交前最终复核）。

## 正式包与真机

- 源码提交：`58f2a2d36bd81b4ad65ce1afb6ce6e42455a6f64`，已推送当前开发分支。
- 正式包：versionCode `386`，versionName `1.2.2-canary.372`，包体SHA-256 `8e19aafdab227e1e052ef09ab33a102b6abe944de3d2712efcf0a9bd4b34384e`。
- 包体签名静态审计通过；保数据覆盖安装后，设备绑定、Wi-Fi与游戏存档均保留。
- 2026-11-05 16:04—16:12（北京时间）完成三条退出口令真机复测。

| 退出口令 | trace 后8位 | 进入倾听 | 退出完成与Android UI | 同房普通问答 | 无输入关房 |
| --- | --- | --- | --- | --- | --- |
| 结束倾听恢复聊天 | `96b09c8b` | PASS | `exit_completed`与`voice.state_changed=listening`同毫秒 | ASR“天空为什么是蓝色的”并收到Worker回答 | 回答结束后约5.5秒进入closing/idle |
| 恢复聊天 | `abfbe6e2` | PASS | 同毫秒发布普通`listening` | ASR“天空为什么是蓝色的”并收到Worker回答 | 回答结束后约5秒进入closing/idle |
| 小可结束倾听 | `4ef62cc8` | PASS | 同毫秒发布普通`listening` | ASR“1+1等于几”，回答“1+1 等于 2” | 回答结束后约5.4秒进入closing/idle |

补充判定：

- 三轮均经过真实`proposal accepted → enter_completed → exit proposal accepted → exit_completed`，不是仅凭界面或普通聊天推断。
- `PREPARING`期间未被遗留普通5秒空闲截止时间提前关房，修复目标通过。
- 六服务`6/6`；本轮Launcher Fatal/ANR为`0`；GM模拟人在开关已恢复为`0`。
- 一次独立唤醒连接出现服务端会话端点瞬时超时并按既有逻辑干净关房，随后三轮正式定向测试全部成功，不影响本次客户端竞态修复判定。

## 证据

- 真机选取日志：`D:\ChatGPTProjects\_codex-temp\p003-g2\v386-listening-exit\device-retest-20261105\voice-v386-selected.log`
- 选取日志SHA-256：`023a1f965f98562fee8c6a30ebdb0c7aa163a7697beac4cc3e749e93966019ea`
- 每轮结构化结果与截图：`D:\ChatGPTProjects\_codex-temp\p003-g2\v386-listening-exit\device-retest-20261105`
- 日志、回执与聊天均未记录Token、完整设备身份或无意义的ADB序列号。

结论：v386客户端修复及三条退出口令真机验收通过，可以作为本轮Android侧收口回执。
