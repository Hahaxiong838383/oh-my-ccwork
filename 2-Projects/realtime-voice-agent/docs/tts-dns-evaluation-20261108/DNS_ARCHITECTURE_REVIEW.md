# TTS DNS 架构审查（只读）

范围：本树与主池 e980 同源的 `voice_connect.rs` / `tts_xfyun.rs` / `tts.rs`；`Cargo.lock` Hickory **0.26.3**（`system-config`+`tokio`）。现役以本目录 `BASELINE.json` 为准：主 057f 开 `P003_ASYNC_DNS_V1` 与 `P003_TTS_CONNECT_RECOVERY_V1`，LATENCY/DNS_HEDGE 为空；倾听 85de/636b 另带 DNS hedge。不改业务、不测网、不重验 e980。

## 已证

1. **异步主解析读 `/etc/resolv.conf`，最终打 stub。** `voice_connect.rs:74–78` 调 `TokioResolver::builder_tokio()`。Hickory `resolver.rs:76–78,112–113` 经 `system_conf/unix.rs:26–27` 读该文件。现役该文件指向 `stub-resolv.conf`，`nameserver 127.0.0.53`。Hickory 名单只有 stub，看不到链路 `8.8.8.8`/`1.1.1.1`。`Cache=yes` 已在 resolved drop-in，作用于 stub，不改 Hickory 名单。

2. **本树 TTS 备用连接仍是同一 stub。** `tts.rs:205–216` 的 650ms spare 再调 `connect_warm`；`tts_xfyun.rs:298–307` 仍进 `:73` 那把 `OnceLock`。系统路径 `:311–316` `lookup_host` 经 nsswitch `files dns` 同样到 stub。ASR 在 `stt_volc.rs:74,200–204` 共用这把 resolver。外层建连预算仍是 `CONNECT_TIMEOUT` 10s（`tts_xfyun.rs:63,294`）。

3. **`timeout=1s, attempts=2` 不是硬 2 秒。** 文档写 attempts 是失败后的重试次数。`RetryDnsHandle` remaining 从 2 减到 0 才停，逻辑发送最多 3 次。每次另套池级 1s deadline（`name_server_pool.rs:313`）和 UDP `Timer::timeout` + `max_retries=3`（`udp_client_stream.rs:60,90–93`）。CNAME 可再串行追跳（`caching_client.rs` 深度 8）。A/AAAA 并行，`dns_ms` 只记胜出族（`voice_connect.rs:110,166–172`）。

4. **`FallbackDNS` 不是快速备用。** systemd 255：仅在不知道任何其他 DNS 时使用。现役链路已有 `8.8.8.8 1.1.1.1`，`#FallbackDNS=` 未启用。

5. **650ms 连接 hedge 与 recovery 互斥。** `tts.rs:187`：`latency_mode() && !connection_recovery_mode()` 才走 `connect_hedged`。主池 recovery=1 → 预热单连，650ms 只在前台 `recover_connection`（`:193–216`）。倾听即使 LATENCY=1 也被 recovery 关掉预热 hedge。`P003_TTS_DNS_HEDGE_V1` 是另一层：仅 85de 在 DNS 查询慢 200ms 后直询 `/run/systemd/resolve/resolv.conf` 的非环回地址（独立上游，attempts=1）；本树/主 057f 无此代码。

6. **OnceLock 要重启。** 本树 `:73` 钉死 nameserver/timeout/attempts。85de 另有 `UPSTREAM` OnceLock。改 resolved 上游但仍走 stub：不必重启。把 `resolv.conf` 改离 stub：Hickory 仍钉 `127.0.0.53` 直到重启；`lookup_host` 可能重读文件。

7. **历史 4704ms 缺该次 DNS 包，不能唯一归因** stub、上游、CNAME 或重试。CNAME/TTL 回执未把它当唯一根因。

## 推断

换链路 DNS 立刻作用 stub 后的 TTS/ASR 异步路径和 `lookup_host`。要绕开 stub 排队，只能程序级独立上游（85de 形态）。单次 lookup 静默大约能到 3s；更长成功更像串行跳或多次查询累加。

## 未知（主 13 在 Worker 测候选）

慢在 Hickory↔stub 还是 stub↔上游；双上游是否并行；4704ms 当次 qname/id/次数。本审查不测网。

## 替换建议

先考虑限定讯飞域名的程序级独立上游（与主 resolver 分 OnceLock），再动系统 DNS。不要指望 FallbackDNS，也不要在 recovery=1 时开 LATENCY 当 DNS 备用。
