证据目录不在允许写入的范围内，文件没有落盘，下面是全文。

# DNS 重试预算与诊断合同（2026-11-08，只读）

模型自报：Grok 4.7（xAI）。这是本轮对话里的自报，不是对模型身份的独立核验。

只读固定对象 `b530c2dbc0847541b0c1d86b0182d4d37984df2c` 的 `voice_connect.rs`、`tts_xfyun.rs`、`stt_volc.rs`，以及证据目录中的 hickory 0.26.3：`retry_dns_handle.rs`、`resolver.rs`、`caching_client.rs`、`cache.rs`。未读即将改动的工作区，未改代码，未联网，未复审已上线的 TTL 补丁。运行源 `ca5f95b4` 与这次对象是否逐字节相同，本轮没有再对。

## ① 预算（条件明确）

`connect()` 把 `timeout=1s`、`attempts=2` 写入 `ResolverOpts`。这四份库文件里，`attempts` 只传给 `RetryDnsHandle::new`。`request_options()` 不拷贝 `timeout`。1 秒不是这些文件里的时钟。下面的区间成立，当且仅当未收录的传输层把每次 `send` 的静默变成可重试 `Err`，且时限就是这 1 秒。这是夹具假设，不能倒推 17:49：那次没有 DNS 包。

`remaining` 初值为 2。超时和 IO 先减一再立即重发，中间无退避。减到 0 之后的那次失败才返回。持续超时是 **3 次 send、失败约 3s**。某次直接 `Ok` 就停止。单 qname 成功因此落在：0 次超时 `(0,1s)`，1 次 `(1s,2s)`，2 次 `(2s,3s)`。已形成报文的 NODATA、`NoConnections`、`DnssecBogus` 不重试。`Busy` 不减次数。

CNAME 追赶只发生在 NOERROR、且沿答案链找不到所请求类型的地址时。`inner_lookup` 串行进行，深度 0 到 7，最多 8 段。同一报文里已经有目标地址就不再查询。`preserve_intermediates` 不增加查询。名字是 FQDN、且第一段已经有答案时，search 不进入这条成功路径。

所以在 1 秒硬截止下，**单 qname 的成功到不了 4704ms**（上界不到 3s）。两段串行可以。386ms 的失败不到一次 1 秒，不是这条预算走满。

可被夹具验证的慢成功（假设）：空 search、冷缓存、FQDN、`timeout=1s`、`attempts=2`。

1. `slow.example.` / A：静默、静默，然后 +800ms 只回答 CNAME 到 `target.example.`，不带 A。
2. `target.example.` / A：静默，然后 +900ms 回答一条 A。

期望约 `1000+1000+800+1000+900=4700ms`，5 个查询、2 个 qname、lookup 成功。对照：同一 qname 两次静默后第三次直接给 A，必须落在 `(2s,3s)` 且只有 3 个查询；第四次静默不得出现。若成功落在 4.7s 或全程只有 1 个查询，则「1 秒硬截止」不成立，本序列作废。

## ② 最小诊断合同

分类放在 `voice_connect`。TTS 用现有 `connect_id`，ASR 用现有 `request_id`，各打一条，不新造 id，不把 URL 传入这一层。对外仍返回今天的 `resolve_failed` / `connect_failed`，避免改调用方匹配的字符串。

每族一个槽，槽在两个 future 外面：`class`（`ok`、`dns_error`、`empty`、`tcp_failed`、`cancelled`、`not_started`）、`dns_ms`、`tcp_ms`、`addr_count`、`tcp_started`、`rcode`（只许 `NoRecords`、`NXDomain`、`NoError`、`ServFail`、`Refused`、`other`）。`lookup` 的 `Err` 才是 `dns_error`，并保留 `timeout`、`no_records`、`no_connections`、`io`、`cname_cycle`、`other`。`addr_count==0` 为 `empty`，此时还没有 TCP。`addr_count>0` 且已经起步的连接全部失败为 `tcp_failed`。终态在 future 返回前写入。槽还是 `not_started` 或进行中时，drop 只记 `cancelled`。`select!` 的败者禁止再 `await`。胜者的 `dns_ms` 仍只覆盖胜出族。

禁止：请求 URI、路径、query、签名、任何头、握手或业务正文，以及对 tungstenite `Request` / HTTP 响应的 `Debug` 或 `Display`。host 沿用调用方已有的固定比较，不从错误链抄。

## ③ 只加日志会碰到的行为

`select!` 和地址 `JoinSet` 都靠 drop 取消。返回前若插入会 `.await` 的日志，败者继续跑，进程内共享 resolver 可能写成缓存，随后的 `dns_ms=0` 以及「取消必须收回预连接」的测试都会变。同步日志若放在 `sleep` 与 `TcpStream::connect` 之间，会挪动 `index*250ms`；第 3 个地址 500ms 才启动，386ms 这一档和单测里的 100/400/600ms 截止会翻转。`reason={error}` 或 `anyhow` 上下文一旦带上 URL，现有 `bail` 会把签名打进日志。在 Drop 里把仍未完成的族写成 `dns_error`，会把取消记成解析失败。日志本身只写枚举；取消路径上不要做 I/O。
