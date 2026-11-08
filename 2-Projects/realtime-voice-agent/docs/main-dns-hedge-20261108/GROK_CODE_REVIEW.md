# Grok 只读审查：主池 TTS DNS 备用候选 5453c80

判定：**PASS 有边界**。这不是生产通过，也不授权部署。

审查对象是提交 `5453c80ffed18c76c93c79be2fb3b52f64e0c043`，基线 `014e4fe6083a4e6c5c12942b5f7a91c8a3bde3c4`。对照倾听树 `85de8fb077a8d455c0ba9e2f4b29e08913820ef5` 的 `voice_connect.rs`。未改源码，未测生产，未重跑 cargo，未看完 release 构建。没有采用上一轮的 6.4GiB/55GiB 或 PSI `full=0`。

## 范围

相对基线只有 3 个路径：

- `docs/main-dns-hedge-20261108/PLAN.md`（新）
- `rust-worker/src/voice_connect.rs`
- `rust-worker/src/tts_xfyun.rs`（成功路径把 `trace.dns_path` 改成 `connected.dns_path`）

`Cargo.toml` / `Cargo.lock` 无差异。`tts.rs`、`pipeline.rs`、`stt_volc.rs` 不在这笔提交里。实现继续用现有 `hickory-resolver 0.26.3`。

`voice_connect.rs` 相对倾听 `85de8fb0` 只有 4 个新测试（`r27_*`）。备用、200ms、进程信号量、CNAME 清缓存和诊断都与倾听核心相同，不是整树覆盖。当前分支和倾听树在历史上还有大量其它文件差异；那些不在 `5453c80` 里。

提交内 `voice_connect.rs` 的 sha256 是 `837cefcb0e321e5c0f646eb4b63e6f75111f009d3f9f59e8f6e4fe8243208f3b`，与 focused/full 证据里的源哈希一致。`tts.rs`、`tts_xfyun.rs`、`job.rs` 的证据哈希也与该提交一致。

工作区现在的 `voice_connect.rs` 比提交多 16 行未提交测试 `r27_fast_transport_failure_is_explicit_and_does_not_expand_retries`。它的 sha256 是 `00977cfa1dfb81f8704a705e08076ae1e9e9776623c9c4b7a4aef29c107fdd05`，不是候选。从脏工作区编出的二进制不能当成 `5453c80`。这份审查没有运行这段草稿。

## 代码结论

200ms 写死在 `family()`：`lookup_with_fallback(..., Duration::from_millis(200), &HEDGES)`。`r27_silent_system_dns_uses_healthy_fallback_to_reach_tcp` 走 `dial_resolvers`，因此用的是这个常数，不是测试里另传的 20ms/40ms。它要求 750ms 内连上，`dns_path == configured_upstream`，且备用查询次数为 1。部分 r26 测试把延迟收成 40ms，只证明机制。

进程许可是 `family()` 里的 `static HEDGES: Semaphore = const_new(2)`。这是全进程一把，A 与 AAAA、以及之后每一次 `connect()` 共用。`try_acquire` 失败就只等系统查询，不排队。许可放在 `lookup_with_fallback` 的局部里，future 被取消或返回时释放。`r26_cancellation_releases_hedge_capacity` 和 `r27_both_resolvers_silent_cancelled_by_shared_deadline` 证明的是传入的信号量；生产用的是上述 static。我是直接读到这把 static 的。

650ms 连接备用仍在未改动的 `tts.rs`：`take_for_sentence` 的 `SPARES` 也是 2，和 DNS 许可不是同一把。恢复预算仍是 10 秒。单次建连最坏是两条系统查询（超时 1 秒、2 次）加最多两条上游查询（超时 1 秒、1 次）。650ms 备用连接可以再发起自己的系统查询；DNS 许可仍被占满时，它拿不到上游名额。上游先失败时，许可会留到系统查询结束，这是少放行，不是泄漏。没有 detached task，也没有第三把 DNS 许可。

CNAME/TTL：`observed_lookup` 在参与竞速之前，按本次 resolver 清掉 ADDITIONAL 形态的缓存。`cname_zero`、多跳 additional、以及备用胜出后的二次查询次数为 2，都在提交测试里。普通应答 TTL 仍会缓存。被提前丢掉、还没走到 `clear_lookup_cache` 的在途失败者，测试没有覆盖；这是倾听核心留下的边界。

阴性 / NODATA：`r27_fast_negative_answer_does_not_trigger_positive_fallback` 用 200ms。NXDOMAIN 和空 NOERROR 都返回错误，备用查询数为 0，许可仍是 2。旧诊断测试要求 rcode 3 / 0，且不进入 TCP。200ms 之后才到达的阴性不再取消已经开始的上游；上游若先给出肯定回答，会胜出。快路径不会。

快速传输错误：第一个 `select` 里，主查询只要在延迟前完成，成功或失败都立刻返回，不占许可，也不查上游。快 NXDOMAIN 已经钉住这条“提前结束的 Err”。提交里没有测试证明“端口立刻拒绝”会在 200ms 内结束，而不是被 Hickory 当成仍在等待。若 200ms 时 future 仍 pending，备用会启动；这正是 UDP 静默路径，红/绿日志覆盖的是这一支。未提交草稿想钉拒绝路径，但不能算进候选。

`dns_path`：成功时改写成 `system_resolver`、`configured_upstream` 或 `literal_ip`。开关打开本身不是备用胜出。`connect()` 失败、还没有 `Connected` 时，日志仍可能停在进入异步 DNS 前写上的 `independent_families`；不能把这个字符串读成备用成功。异步 DNS 关闭时走 `lookup_host`，初值是 `system`。

默认关有两道门，都要精确为 `1`，主机还必须是 `cbm01.cn-huabei-1.xf-yun.com`：

- `P003_ASYNC_DNS_V1`，且 `AGENT_NAME` 是 `rust-worker` 或搜索 canary
- `P003_TTS_DNS_HEDGE_V1`

ASR 会调用 `voice_connect::connect`，但只对 `openspeech.bytedance.com`。它过不了 TTS 主机门，不会启动这套上游。不要为了测试把别的名字加进 `async_dns_enabled`，也不要在倾听池或搜索池打开 hedge 开关。

`configured_upstream()` 只在 systemd stub 管理 `/etc/resolv.conf` 时，从 `/run/systemd/resolve/resolv.conf` 取最多两个非回环、非未指定、非组播地址。`OnceLock` 会记住第一次的 `None`。正式机器必须在进程第一次建连前就已经是托管 stub；否则本进程永远不会备用。

## 证据，只认我读到的部分

- `worker-dns-red.log`：源是旧 `voice_connect.rs` `3c1e1d5c…`，不是候选。`r27_silent_…` 在 0.75 秒失败，断言是“静默系统 DNS 不能把健康备用拖过 750ms”。这是行为失败，不是编译失败。
- `worker-dns-focused.log`：源哈希等于候选，24 passed，0 failed。
- `worker-dns-full.log` 本地摘录的结果行是 566 passed，0 failed，1 ignored。摘录不是完整清单，我没有逐条重数 566。树里既有的 ignored 是 `rtc_business_probe` 的真实 RTC 测试，不在这笔 diff 里。
- release 构建和正式 runner 都还没有由我核对为完成。

## 正式 runner（未执行）

`formal-dns-runner.py` 的方向可以保持：独立 loopback SFU、新密钥、`AGENT_NAME=rust-worker`、故障只发生在该进程的 mount namespace。任意不在名单里的 `AGENT_NAME` 进不了候选 DNS，这是门，不是 runner 的缺陷。不要放宽生产名单。

执行前的边界：

- `dns-new-normal` 不加故障 namespace，会在宿主机 DNS 上带着 hedge 开关跑。`LIVEKIT_URL` 必须仍指向脚本里的 `127.0.0.1:17880`，不能指回生产 SFU。
- 故障用例只替换 namespace 内的 stub。备用读的是未替换的 `/run/systemd/resolve/resolv.conf`，所以依赖真实上游。
- 脚本要在宿主上绑定 `127.86.0.53:53`。我没有检查这个地址是否存在。
- 故障通过条件要求日志里出现 `dns_path="configured_upstream"`。这和成功路径的语义一致；`independent_families` 不能拿来充数。
- 脚本会读生产 unit 的 PID、重启次数和二进制哈希做前后对比。那是隔离检查，不是这次代码审查已经执行的运行。

## 不在本判定里的事

未部署，未改生产 DNS，未证明线上时延或资源。正式隔离运行完成之前，不能把本判定写成验收通过。
