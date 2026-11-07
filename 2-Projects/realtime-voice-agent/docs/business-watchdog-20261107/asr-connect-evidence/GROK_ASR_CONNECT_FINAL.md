# Grok 第二轮结论：只回应三点质证，并核 713f6f35 的四个运行增量

身份：xAI Grok 4.7，独立只读。没有改源码，没有部署，没有碰设备，没有复跑测试。结论只覆盖父提交 `b373b355d20dcd47802012e1b33db72d7acc32fa` 到 `713f6f35af43d5a58aeae8360ad421fc66b72718` 的四个运行文件：`business_runtime.rs`、`business_watchdog.rs`、`pipeline.rs`、`stt_volc.rs`（约 +203/−10）。同提交里的文档和 DNS 配置不在本轮。工作区 `stt_volc.rs` 另有 42 行未提交测试，不计入 `713f6f35`。

这不是全量通过，也不是 Android 通过。生产二进制仍是 `50017a8998197d84fcc58957e0979ea13f56aabe0758ba9ea2ab2aff468de4d0`。新 release `3dd0430aaf97d3ef5d056d871f3d87a64c66508c0b9b8cf9702bc9f0e73e70cb` 未部署。

## 修订

1. **撤回「本轮 VAD 结束尾巴永远不发送」。** `release-dispatch-probe-asr.py` 在 wav 播完后仍 `capture_frame`，默认 `bytes(320)`，即 160 个零样本，直到断房。`rtc_business_probe.rs` 在 4500 帧循环里同样先填 160 个零，只有仍在播语料时才覆盖。普通路径 `pipeline.rs` 对非空样本无条件 `stt_buf.extend`，满 3200 才 `try_send`，不看 VAD，也不看 ordered。后续静音会补满 3200。因此本轮最多是约 200 毫秒的分块等待，不是尾巴永久留在 `stt_buf`，也不能据此要求本轮加 VAD 尾冲刷。音轨真正不再来帧时的短尾是另一边界，没有证据表明它造成这次首句全丢。

2. **撤回「9.7 秒减去 6.7 秒还剩至少 3 秒」。** 9.7 秒是失败轮从 spawn 到进程退出、且没有 `asr: connected` 的整段。6.7 秒是约 2.5 分钟后另一次 `getaddrinfo`。两次调用不能相减，差值没有阶段归因意义。能保持的说法只是：该 9.7 秒没有同一次 DNS/TCP/TLS/WS 分段。

3. **语料定性收紧。** 初审里的「探针 PCM 能量」应读成：固定自制文件 `normal-short.wav`（脚本写死的 sha256 `9ea46b2c12e570ab71a4b10283c733331d2048331b0b876df47b9a78b10f0b03`）经真实 RTC 进入 VAD。不是现场真人原录音，也不是 Android 麦克风。

## 同意，且第 4 点未见确切阻断

对照 `713f6f35`，下面四条都有直接代码，没有找到能拆掉它们的反例。因此不要求为这些条款重写。

- **10 秒连接预算包住两条路径。** `CONNECT_TIMEOUT` 为 10 秒。`connect_observed` 用同一个 `timeout` 包住 DNS、TCP、TLS 和 WebSocket。`P003_ASR_CONNECT_RECOVERY_V1=1` 且主机名恰好是 `openspeech.bytedance.com` 时才调用 `voice_connect`；否则仍是 `lookup_host` 加一次 `TcpStream::connect`，但不再是无界 `connect_async`。鉴权头在进入连接前写好，原请求交给 TLS。成功前的接收循环还没开始，所以不会先取 PCM。`voice_connect` 的地址尝试在 `JoinSet` 里，随 future 丢弃而停；生产路径没有脱离的 `tokio::spawn`。
- **fresh VAD 才刷新 15 秒 Recognition，轮询不续。** 只有 VAD `active` 调用 `asr_speech`。截止时刻是该次 `at + 10s + 5s`，经 `begin_activity(..., until, 0)` 存成绝对时刻。提交内测试是语音后 1 秒起算，15 秒仍 Keep，16 秒 `IdleNoProgress`。interim、心跳、ready 和 1 秒轮询都不调用它。轮询只更新 Reply、Command、Search、Input。静音不刷新。连续真语音会把窗口推到最后一帧之后 15 秒，这是约定的 fresh VAD，不是无界续租。15 秒是本地策略，不是供应商 SLA。签发 idle 仍是 5 秒。
- **final 清除，且不能无语音复活。** 非 ordered 的 `SttEvent::Final` 调用 `asr_final`：取走 slot、按当前 generation `end_activity`，只有未过截止才 `progress`。没有前次 `asr_speech` 时 slot 为空，空转。提交内测试：9 秒 final 后，14 秒按 5 秒 idle 关闭；15 秒再来一次 final 仍关闭。ordered 首句在 VAD 之前就 `continue`，不会叠这条租约。
- **typed 连接错误不再六次 10 秒。** 超时和失败都变成 `ConnectFailure`。`spawn_stt` 在 `elapsed > 10s` 清零 `fails` 之前就 `break`。事件消费者关闭返回 `AsrEnd::Unused`，同样 `break`，不重连。重试循环本身不调用 `asr_speech`，所以重试不续 Recognition。已连通之后的 `ServerClosed` 和发送错误仍走旧重连；这是对方已声明保留的旧行为，不是本条被绕开。

默认路径上，第一个地址若黑洞，可能吃满同一个 10 秒，后面的地址来不及赢。这不拆掉 10 秒上限。对方已说明现有 DNS 夹具的首地址是拒绝，不声称黑洞端到端已验。本轮也不把这一点升成重写理由。

## 未验

- 541 通过、1 ignored 是对方的隔离执行报告。本轮没有复跑。`ASR_CONNECT_RTC_READ_1.json` 里的 `541 filtered out` 是单次过滤，不能当作这 541 项的通过证据。
- 候选 debug 普通问答：同文件 `ordered=0`、`exit=0`、`user_finals=2`、`audible_ms=8390`、自然关房 `Gone`。进程直接跑 job，不注册 Worker。主进程仍是 PID `3496776`、二进制 `50017a89…de4d0`。同一次连接计时 `elapsed_ms=822`（DNS 566、TCP 4、TLS/WS 249）。这是一个成功样本，不是历史故障的根治证明。该探针没有严格计 metrics。`ordered=1` 在这份读回里是 `result=null`。
- 正式 release 探针、Android、失败轮的同 trace 分段、黑洞地址端到端，都没有在本轮新测。

## 部署

**不部署。** 生产保持 `50017a89…de4d0`。不要把隔离通过或这一次 debug 普通问答写成可上线，也不要写成全量或 Android 通过。若以后另开验收，至少需要：固定源码对应的正式 release、普通与 ordered 各一轮、metrics 按原合同计数，并且仍用合成票与自制语料的边界来写结论。本轮不要求为尾巴或 3 秒差值再改代码。
