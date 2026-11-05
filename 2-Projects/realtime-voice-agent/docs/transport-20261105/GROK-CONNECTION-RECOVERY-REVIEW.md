**结论：`P003_TTS_CONNECT_RECOVERY_V1` 可以做，但只能作为默认关闭的句就绪连接竞速。现稿有 6 条必须先钉死，否则会把 4 秒预算写成第二次 10 秒，或在名额满、超龄、取消时直接无声。它不证明 TLS/WS 卡住的根因，也不覆盖 t22。**

对照当前代码：`warm.take()`（`tts.rs` 177–192）会把预建连等到结束；10 秒只包在 `connect_observed`（`tts_xfyun.rs` 63、294–334）。句就绪后若预建连失败、为空或龄期 ≥12 秒，`synthesize`（452–462）再开一条全新 10 秒。`P003_TTS_LATENCY_V1` 的 650ms 对冲在 `Prewarm::arm`（166–172），并且 `pipeline.rs` 3531 还会把它用于搜索轮的最短垫句。旧 flag 保持 0 时，这两条都不能动。

## 必须阻断

1. **4 秒必须从本句 `synthesize` 入口起算，到点 abort 主连接和 spare。** 不能复用现在的 `connect_hedged`（206–221）：它从预热启动起算 650ms，失败后是无截止的 `spare.await` / `primary.await`，名额用尽时更是直接 `return primary.await`。`JoinHandle` 被 drop 不会停止任务。截止、打断、对端胜出都必须显式 `abort`。`hard_abort_current` 只 `turn.task.abort()`（2654–2655），所以 spare 若另起任务，竞速 future 的 Drop 里也要 abort 它。同一轮已经完成的 fresh `Warm` 必须保留，截止分支不能把它丢掉。

2. **竞速失败、超龄或 flag=1 时，禁止进入 `tts_xfyun::synthesize` 的冷连分支。** 新接口只接受调用前已经 fresh 的 `Warm`；否则直接 `Err`。fresh 以现有 `WARM_MAX_AGE`（12 秒，从 `connect_observed` 的 `trace.start` 算）为准，发送前再查一次。剩余预算不够就返回 `Err`，不另开 4 秒，也不另开 10 秒。

3. **超龄、预建连已失败，仍先有一条不占 spare 名额的 cold primary。** spare 只是第二路：650ms 仍挂才启动；primary 若在 650ms 前失败，立刻启动 spare，但仍吃同一条 4 秒。进程内 `try_acquire`，上限 2，不排队。名额用尽时继续等 primary，到 4 秒返回 `Err`。超龄连接不能算作这条 primary，也不能只靠 spare 名额补位；否则两个在途 spare 会让本句零次建连。

4. **先结束竞速，再发文本。** 只给胜出的那条连接发送一次；失败路不调用 `build_request`。已有 PCM 后不重试。`tts.rs` 116 的下一句预热必须在竞速结束并处理完输家之后 arm 一次，成功和 `Err` 都 arm。竞速完成前不能 `*warm = start_prewarm()`，否则旧 `Prewarm` 的 Drop 会把仍在竞速的 primary abort 掉。后台预热保持单连接。spare 单独 `connect_warm`，用新的签名时间，不复用卡住那次的 URL。

5. **独立开关，默认关闭。** 只读 `P003_TTS_CONNECT_RECOVERY_V1=1`。不打开 `P003_TTS_LATENCY_V1`，不改 `latency_mode()` 和垫句条件。flag=0 时，`arm`、`take`、失败后再走 10 秒冷连，全部保持现状。火山路径不进这段逻辑。

6. **连接 `Err` 保持现在的 pipeline 语义，不用重合成补静音。** Reply/tail 是 warn 后继续下一句（3851–3853、3874–3876），失败句不 `track`。Say 同样不重试，随后仍会 `push_assistant`（3736–3742）。搜索播报是 `_ => break`（3721），第一句连接失败会丢掉后面各句。flag=1 会让这些路径在约 4 秒出现，而不是现在的预热剩余时间再加 10 秒。实验要接受该句无声；搜索路径要接受后续句一起不播。

## 4 秒与无声

4 秒是实验保护上限，不是讯飞 SLA。已有证据里，卡住的那次是 `tls_ws` 上约 10001ms 的超时；随后另一次连接 893ms 成功。健康样本大约是 238ms 建连、365ms 首包。没有连接在 4–10 秒之间成功的记录，所以 4 秒削掉的是「挂到 10 秒再失败」，外加现在这条二次 10 秒。若同一次故障会在 4 秒后、10 秒前自行完成，flag=1 会把那次成功变成无声。spare 只有在故障跟单条 socket 走、换一条就能通时才有用；这一点尚未证明。两路都失败就保持该句无声，这是预算的代价。

t22 不在本旗范围内：连接和首包已经完成，之后 3 次欠载 2922ms。本设计在发文本前结束，不改 `RECV_TIMEOUT`、读循环、32 格通道或播放。刚完成的 8 次短句/长句直连成功，不能用来关闭 6075 或 t22。

## 最小验证

用假连接做单测，不打外网，不读凭据，不断言根因已修复。

- flag=0：主连接未完成时继续等到它自己失败；不启 spare；失败后仍允许旧的一次冷连。
- 200ms 完成的 fresh 预热：只用这一条，连接次数为 1。
- 主连接一直挂起：650ms 才出现 spare；胜出后、发送前输家已 abort；4 秒时两路都 abort，且没有第三次连接。
- 主连接 10ms 失败：spare 立即启动；两路都失败则 `Err`，调用次数为 2。
- spare 名额为 0：主连接成功仍返回；主连接挂起则约 4 秒 `Err`，许可数不变。
- 龄期 12.1 秒：不发送，先 cold primary，仍挂再一条 spare，旧 socket 已 drop。龄期 11.9 秒：直接使用，新连接数为 0。
- 截止与完成同时就绪：保留 fresh `Warm`。取消父任务：主连接、spare 都退出，许可归还。
- 发送回调最多一次，且只发生在 fresh `Warm` 之后。`Ok` 和 `Err` 都只 arm 一次下一句预热。
- 不改 pipeline 的三个 match：Reply 的 `Err` 不 `track` 并继续；搜索路径仍 break。

日志沿用现有 `connect_id`、`stage`、`outcome`、`prewarm_wait_ms`，另加 `recovery`、`spare`、`budget_ms`、`age_ms`。不记录签名 URL。flag=0 与 `P003_TTS_LATENCY_V1=0` 时，垫句选择和连接次数应与现在一致。
