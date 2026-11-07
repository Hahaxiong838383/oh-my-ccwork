本轮是只读质证，工作树未改。固定候选 `de09010304f2a44556bd706c7b810828062b4433` 没有代码级上线阻断。意见支持把它放到现役倾听池做单机受控部署。648 不能当作生产通过，也不能给老房清理、历史流中故障或搜索池销号。

模型身份只有系统指令中的可核值：xAI Grok 4.7。环境里没有另一份模型版本号，只有 `GROK_SESSION_ID=01a1b785-3eeb-78d2-b101-074e117d25b5`。下面的测试计数全部来自已有日志，我没有跑过 `cargo test`。

## 证据边界

工作树干净，`HEAD` 就是 `de090103`，父提交是 `5b3fdaac`。`5b3..de090` 只改了这五个运行文件，`+1053 / -42`。我对 `de090103` 的文件内容做了 SHA256，和 `source-green-listening-transport-2.json` 的 78 项全部一致：5 个运行文件相对 `5b3fdaac` 有变化，其余 73 项与旧基线相同。

| 材料 | 我核到的结果 |
|---|---|
| 旧基线日志 | `568 + 29 + 9 + 7 = 613` 通过，2 个 ignored。日志开头没有 source hash，关联只到文件名和计数 |
| 红日志 | `570` 通过，3 个失败，2 个 ignored。失败只是 `cname_target_in_additional_is_not_discarded_as_no_addresses`、`cname_additional_ipv6_remains_usable`、`multihop_and_zero_ttl_additional_results_are_requeried` |
| 绿日志 2 | `603 + 29 + 9 + 7 = 648` 通过，0 失败，2 个 ignored。点名测试在完整日志里为 ok，包括 `r15_connect_failure_reports_stage_without_response_headers_or_signed_url`、`candidate_recovery_keeps_first_pcm_deadline_and_never_replays_text`、`candidate_fallback_cname_ttl_and_diagnostics_stay_on_own_resolver` |
| 主池 552 | 未重跑 |

同目录还有一份 `green-listening-transport-3.log`，二进制测试计数是 604。它没有可核对的 source hash，本轮不采用。

## 1. 没有代码级上线阻断

五个文件里没有会单独挡住这次单机部署的缺陷。现役倾听进程的恢复开关仍是空：`P003_TTS_CONNECT_RECOVERY_V1` 和 `P003_ASR_CONNECT_RECOVERY_V1` 都未设置。因此 `take_for_sentence` 这条恢复路径在“只换二进制、不改 env”时不会进入。

会随二进制生效的行为是：

- 讯飞接通进入 `connect_observed`，单次预算 10 秒，失败原因收成静态分类或 `http_N`。
- 异步 DNS 打开且主机是 `cbm01.cn-huabei-1.xf-yun.com` 时，CNAME 目标可以取自 ADDITIONAL，并用过 ADDITIONAL 的解析器清自己的缓存。
- 火山接通失败返回 `ConnectFailure`。`pipeline.rs` 见到这个类型就结束本次 ASR，不再做原来的多次重连。流中途的其他错误仍走原重连。这是候选有意写进测试的行为，部署时要盯 ASR 接通失败，不是隐藏缺陷。

`FirstAudioBudget` 在 `tts.rs` 的 `synthesize` 里只构造一次。恢复路径把同一个 budget 移进 `synthesize_connected_budgeted`，`allow_cold_connect` 为假，文本只在 `synthesize_inner` 发送一次。`candidate_recovery_keeps_first_pcm_deadline_and_never_replays_text` 锁的是这条缝：获取花掉 90 毫秒后，剩余期限仍使合成在 140 毫秒内失败，服务端看不到第二条文本。

## A. 签名 URL 泄露降为扩展防御，不是已证实漏洞

外层 warn 在 `tts.rs` 预热失败处，`warn!(error = %e)`。`e` 来自 `connect_observed` 的：

```369:372:2-Projects/realtime-voice-agent/rust-worker/src/tts_xfyun.rs
Ok(Err(e)) => {trace.reason=crate::voice_connect::safe_failure_reason(&e);e.to_string()},
_ => {trace.reason="connect_budget";"timeout".into()},
};
bail!("xfyun connect stage={} reason={}", trace.stage, reason)
```

这里的 `e.to_string()` 发生在内层错误已经替换之后。我沿接通闭包和 `voice_connect::connect` 逐个 `?` 看过，能到达这行的生产主机路径只有这些静态值：`invalid_request`、`invalid_host`、`resolver_init`、`resolve_failed`、`resolve_cname_cycle`、`connect_failed`、`tls_failed`、`io_failed`、`handshake_failed`，以及 `http_` 加状态码。签名 URL 在 `build_auth_url` 成功后进入 `connect_observed`，失败分支不把原始 `tungstenite::Error` 或 Hickory 错误交出来。`r15_connect_failure_reports_stage_without_response_headers_or_signed_url` 用 `authorization=DO_NOT_LOG` 和响应头 `X-Private: DO_NOT_LOG` 检查了 Display 和 Debug，绿日志为 ok。

火山侧更窄：`connect_observed` 在记录静态 `reason` 后返回 `ConnectFailure`，Display 固定为 `asr connection failed within bounded episode`，原始错误不进入 `pipeline.rs` 的 warn。

我没有找到一条能把签名 URL 或查询名送到外层 warn 的可达原始错误。字面 IP 的 `TcpStream::connect` 会返回操作系统 I/O 错误，但异步 DNS 只对讯飞和 `openspeech.bytedance.com` 开放，这两条主机都不会走进字面 IP。因此前轮结论降为扩展防御：`bail!` 仍拼接 `e.to_string()`，以后若有人在超时闭包里直接 `?` 一个原始错误，warn 才会放开。当前不是已证实漏洞，也不构成阻断。

## B. 在每个 resolver 返回前清自身缓存，比只清赢家正确

`observed_lookup` 在 `resolver.lookup` 之后、`Ok(lookup)` 之前，只清本次使用的那个 resolver：

```197:203:2-Projects/realtime-voice-agent/rust-worker/src/voice_connect.rs
if !uncache_names.is_empty() {
    resolver.clear_lookup_cache(host, kind);
    for name in uncache_names { resolver.clear_lookup_cache(name, kind); }
}
Ok(lookup)
```

`uncache_names` 仅在地址来自 ADDITIONAL 时非空。普通 ANSWER 里的地址仍按原 TTL 缓存。`lookup_with_fallback` 的 `select` 要等某个 `observed_lookup` 变成 Ready 才选赢家。Future 只有在执行完清缓存并返回之后才会 Ready。两个分支都完成时，Tokio 的 `select` 可以丢掉其中一个成功结果；被丢掉的分支已经清过自己的缓存。若改成选中赢家后再清，完成但落选的 resolver 会留下 Hickory 按较长 CNAME TTL 缓存的 ADDITIONAL。下一次查询可能直接命中这份长缓存。

清缓存不改已经返回的 `Lookup`，当前接通仍用这份地址。主查询和上游用的是两个 resolver，查询名分别是原主机和带尾点的绝对名，清的也是各自刚查过的键。

现有 `candidate_fallback_cname_ttl_and_diagnostics_stay_on_own_resolver` 证明的是静默主查询加获胜上游：上游计数为 2，诊断落在 `configured_upstream`。它还没有覆盖“两边都成功，落选的一边也已完成”。这一缺口不推翻上述控制流，因为清缓存发生在返回之前。

## 2. 还需要的交叉验证

运输候选内部，前轮点名的红绿和新增交叉已经在哈希对齐的绿日志里通过。还不能算完成的是：

- 识别保持。`PENDING_LISTENING_RECOGNITION_HOLD_TEST.rs` 是 `delayed_six_second_handshake_delivers_final_before_recognition_hold_expires`，它依赖 `business_runtime` 和 6.5 秒握手。绿日志的 78 个源文件里没有这个模块，2 个 ignored 是 Brain HTTP 联测。这项没有移植完成。
- 单机部署后的实际观察：ASR 接通失败不再重试、讯飞 ADDITIONAL 地址是否被采用、恢复开关是否仍为空。这不是再跑一遍 648。
- 搜索池仍是另一条线。`release-status.json` 写着 `worker_commit=f57625906c66b49a4511cffd2106216a970b5ac5`、`worker_sha256=56f6878f1a232139f8bba968af3a2331c03bb842ad87228a8f63a01ed77ec53c`。我只核了这份 JSON，没有重新计算现役二进制。

可选加强，不挡住单机：让主查询和上游都返回 CNAME+ADDITIONAL，并断言落选 resolver 的下一次查询计数也增加。

## 3. 部署意见

支持把 `de090103` 作倾听池单机受控部署，保持该进程现有 env。`POOL_RECOVERY_FLAGS_20261108.json` 在 `2026-11-07T19:36:39Z` 记录倾听与搜索都是 `P003_TTS_DNS_HEDGE_V1=1`、`P003_TTS_FIRST_PCM_BUDGET_MS=10000`、`P003_TTS_LATENCY_V1=1`；两个恢复开关为空。主池相反，恢复开关为 1，这三项为空。不要把主池 env 抄到倾听进程。

`BRAIN_POOL_HEALTH_20261108.json` 的倾听 release manifest 是 `build_sha=5b3fdaac…`，`expires_at_ms` 对应 `2026-11-11T10:00:00Z`，当时 `registered=true`。倾听 health 的 `until_ms` 只比 `at_ms` 晚 15 秒，是快照当时的心跳，不是一份仍在有效期内的长期租约。搜索 health 的 `until_ms` 是 `2026-11-02T03:19:11Z`，到快照时已经过期。这份快照不证明 11 月 8 日心跳仍在刷新。

明确不支持：把 648 写成生产通过；关闭老房清理和历史流中故障；宣称识别保持已移植；把本候选部署到搜索池。
