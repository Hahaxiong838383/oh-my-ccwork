实际模型是 Grok 4.7。结论是 PASS，不阻断候选 `72053ae` 上主池。只核了它相对 `b530c2d` 的 `voice_connect.rs`、`stt_volc.rs`、`tts_xfyun.rs`，没有重跑测试，也没有把工作区随后的 `b9114ac` 算进结论。

预算没有改。三文件 diff 未动 10 秒 `CONNECT_TIMEOUT`、`dial` 的 50ms 族错开、地址任务的 `index * 250` 与 `take(8)`，也未动 `client_async_tls` 和 PCM。650ms 备用在 `tts.rs`；绿日志里该文件的 sha256 与 `72053ae` 相同。

关联和释放成立。`connect` 包在 `voice_connection` span 中，ASR 键是 `request_id`，TTS 键是 `connect_id`，外层 `ConnectTiming` 也直接写这两个键。地址任务使用 `in_current_span().with_current_subscriber()`。tracing 0.1.40 的 `Instrumented` 在 Drop 时会 enter 自身 span。`JoinSet` 析构只 `abort`，不 `detach_all`，失败套接字随 future 释放。每个族 1 条 DNS 日志，每族地址最多 8 条。族记录在进入 TCP 前就 drop，因此 TCP 失败不会改写 DNS 结果。

分类与绿测一致。取消默认是 `cancelled`/`owner_dropped`；外层预算耗尽另记 `timeout`/`connect_budget`。`NoRecordsFound` 把 NXDOMAIN、NoError 分成 `nxdomain`、`nodata`，TCP 只记 `ErrorKind`。`safe_failure_reason` 只认固定串，完整的 `http_` 加 100–599 才算 `http_rejected`；`Msg` 和带正文的 HTTP 落到 `dns_other`/`other_failure`。ASR 对外只返回 `ConnectFailure`。TTS 的 `bail` 仍拼接 `e.to_string()`，但这条路径上的字符串是 `resolve_failed`、`http_403` 这类固定哨兵，日志字段用的是安全分类。

证据对得上。final 日志 rc=0，551 passed、0 failed、1 ignored；`voice_connect.rs` 的 sha256 `32e3f583…` 等于 `72053ae` 的 blob，`tts_xfyun.rs`、`tts.rs`、`job.rs` 也一致。red 日志 rc=101，547 passed、2 failed，失败在旧行号 131 和 144，输出里没有诊断行；该 `voice_connect` 摘要不是 `b530c2d`。红绿都有 1 个 ignored。

未验边界有三处。绿测没有等待 `remote_abort` 之后的落败地址 Drop。`WithDispatch` 只在 poll 期间切换 subscriber，所以非全局 subscriber 下，取消行可能进不了当时的捕获器；生产 `main` 用全局 fmt，默认级别 info。新测试直接调用 `dial`/`family`，两份日志都没有 `asr`/`tts connection timing` 行，`stt_volc.rs` 也不在 final 的 `source_sha` 里。字面 IP 和未打开 async DNS 的系统解析没有族/地址记录。
