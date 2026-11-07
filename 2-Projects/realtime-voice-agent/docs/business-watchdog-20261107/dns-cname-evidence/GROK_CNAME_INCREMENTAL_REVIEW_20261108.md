# CNAME additional 限定增量审查（2026-11-08）

模型自报：Grok 4.7（xAI）。这是本轮对话里的自报，不是后台对模型身份的独立核验。上一份假设在 `GROK_TTS_DNS_HYPOTHESES_20261108.md`，用户标明 session 174；本轮没有核过那个 session 号。

范围：只审 `rust-worker/src/voice_connect.rs` 的 CNAME 选址。没有改源码，没有 SSH，没有探针，没有安装，没有重新启动代理。测试日志是已有文件，本轮没有重跑。

## 结论

1. 候选文件 SHA256 是 `85229df015d1f0caeb41f0b007aa72cf85e50c188478e7ac8e6a41bc0faee7fb`，与指定值、工作树、`HEAD`、提交 `282a4167`、`source-dns-cname-additional-green.json` 和 green 日志头一致。
2. 生产源码 `713f6f35` 的 `voice_connect.rs` 内容哈希是 `1b7c945a2d8f5b9827022d8d6725502d020dd939fbc0676a7766daca10dace2a`。第 41–44 行只从 `lookup.answers()` 取 A/AAAA，不看 owner，不看 additional。
3. 这个候选可以受控部署，用来修一个明确缺陷：Hickory 0.26.3 在默认 `preserve_intermediates=true` 时可以原样留下 answer 里的 IN CNAME，把最终 owner 的地址留在 additional；旧的 `answers()` 会把这次成功解析变成没有地址。green 测试连到 `127.0.0.1`，没有连到陷阱 `127.0.0.2`。
4. 没有必须改的源码行。阻断项为空。
5. 它不解释历史同一次连接的 `dns_ms=4704`、`tcp_ms=51`、`tls_ws_ms=170`，也不解释 650ms 备用的 386ms `resolve_tcp` 失败。新时间线里这个名字的单次查询是 0.386–186.994ms，没有未应答，没有 4.7s。
6. 冷批第 3 轮（`round` 2）功能 JSON 是 PASS，进程退出码是 -6。Worker `MainPID=3512437`、`NRestarts=0`、`ActiveState=active`。功能 PASS 不是整进程验收。

## 实现

`lookup_addresses`（47–69 行）从 `lookup.query().name()` 出发，只在 answer 里沿 IN CNAME 走，用 `HashSet` 碰到重复 owner 就 `resolve_cname_cycle`。每一跳都重新扫描，报文里的 CNAME 顺序不影响结果。然后只收最终 owner、class IN、并且族别匹配的 A 或 AAAA；answer 在前，additional 在后，重复地址丢掉。

这和本地抽出的 Hickory 0.26.3 一致。`caching_client.rs` 在 `preserve_intermediates=false` 且已经找到 CNAME 目标时会改写 answer；默认值不在这 4 个抽出的文件里。公开标签 v0.26.3 的 `crates/resolver/src/config.rs` 里 `default_preserve_intermediates()` 返回 `true`。应用只改了 `timeout` 和 `attempts`，没有改这个开关。green 能通过，也要求返回给应用的 Lookup 里 CNAME 还在，最终 owner 的 A 仍能被 53–67 行选中。若默认改成 false，Hickory 会拿掉 CNAME、把目标 A 放进 answer，而 query name 仍是原名，现有 walker 会选空。当前 0.26.3 默认不是那条路径。

跨查询追赶时，Hickory 自己的深度上限是 8（`DepthTracker::MAX_QUERY_DEPTH`）。`preserve_intermediates=true` 时，最终 answer 会保留前面的 CNAME。缓存命中的报文用原始查询名，未命中返回的内层 Lookup 用最后一跳的名字。两条形态 walker 都能落到最终 owner 的地址。应用没有自己写 TTL。`lookup_from_cache`（约 300–309 行）只用 answer TTL 的最小值。

生产调用面：`tts_xfyun.rs` 只在 `P003_ASYNC_DNS_V1=1` 且 host 正好是 `cbm01.cn-huabei-1.xf-yun.com` 时进入 `voice_connect::connect`。`stt_volc.rs` 在 async 打开且 host 是 `openspeech.bytedance.com` 时调用同一个函数。系统 `lookup_host` 路径没变。

## 阻断

无。没有必须修改的行。

## 非阻断

1. 测试没有锁住线上 A 形态。冷批报文是 answer CNAME `cbm01.cn-huabei-1.xf-yun.com` → `hb-kaicp.xf-gtm.com`，六条 A 的 owner 都是 `hb-kaicp.xf-gtm.com`，TTL 30，CNAME TTL 60。现有 `cname_additional` 把目标 A 只放在 additional。walker 逻辑能覆盖线上形态，但 green 不保护它。若要补，在 `dns_server` 约 114–128 行加一种 answer 内 CNAME + 目标 A，additional 放无关地址；测试放在 173 行之后。这不是部署前的代码改动。
2. TTL 断言过强。116–118 行 CNAME 和 additional A 的 TTL 都是 1。169–172 行能证明大约 1 秒后会再查，不能单独证明更长的 additional TTL 不会把缓存拉长。`lookup_from_cache` 不把 additional TTL 算进最小值。应用按 resolver 的截止时间用地址，符合「TTL 仍由 resolver」。不要在 `lookup_addresses` 再写一套 TTL。
3. IPv6 测试 175–180 行没有陷阱地址，也没有 TTL 重查。族别过滤本身是对的：AAAA 查询只收 AAAA。
4. 红日志的 panic 字符串是 `resolve_failed`（`voice_connect.rs:137:149`）。生产 `family` 只把 `lookup` 错误收成这个字符串；空地址走 `addresses_connect` 的 `connect_failed`。`dial` 83–86 行在一族失败后返回另一族的错误。`cname_additional` 的 AAAA 查询会得到空 NOERROR，Hickory 把它变成 lookup 错误。因此红日志这串字不能单独证明 A 查询失败。green 连到 `127.0.0.1` 才是这个缺陷的证据。不必为这轮改 `dial`。
5. 取消没有新的等待点。选址是同步的。`JoinSet` 在成功或 drop 时丢掉未完成连接，`select!` 在一族成功时丢掉另一族。`r16_dns_dial_cancellation_is_bounded` 只证明调用方 100ms 超时能先返回，没有观察 lookup 或 socket 是否已中止。这是原行为。
6. 多地址仍是 `take(8)` 和每档 250ms（21–29 行）。冷批这条应答是 6 个 A，在上限内。去重是新行为，只在同一地址重复出现时少打一次。
7. CNAME 只沿 answer 走，不沿 additional 里的 CNAME 走。观察到的链是 answer 里的一跳。报文内链没有 8 的上限，只有环检测和报文大小。
8. 同一个 `connect` 也服务 ASR 的 `openspeech.bytedance.com`。本轮没有重读那个名字的报文。受控部署这个二进制时，ASR 的 async 选址会一起换成这套 owner 规则。线上讯飞 A 形态下，新旧都会拿到那 6 个 answer A。

## 与 4.7 秒分开

新捕获里 `cbm01.cn-huabei-1.xf-yun.com` 的 A 查询（qtype 1）都是一条查询、rcode 0、answer 里 1 条 CNAME 加 6 条 A。时间：isolated 7.884、9.529、185.84、186.994、0.796ms；RTC A 1.767、2.748ms；RTC B 5.859、7.45ms。ens17 与 lo 是同一次应答的两面，不是两次解析。AAAA（qtype 28）是 answer CNAME、authority SOA，additional 里是 A 不是 AAAA，随后对 `hb-kaicp.xf-gtm.com` 的 AAAA 只有 SOA。新代码按族丢掉这些 IPv4 additional，旧的 `answers()` 同样看不到它们。

4704ms 是一次已经成功的 A lookup。地址被丢掉会表现为失败，不会表现为 4.7 秒后连上并得到 peer。386ms 备用失败仍没有对应 DNS 包。这三份时间线 `unanswered` 为空，`parse_errors=0`，没有长等复现。

## 探针

`TTS_DNS_COLD_BATCH_READ_2.json`：round 0 和 1 的 `rc=0`、`status=PASS`；round 2 的 `status=PASS`、`rc=-6`。runner 因 `returncode==0` 失败。`DNS_COLD_PROBE_ABORT_EVIDENCE.json` 的 probe.log 在 PASS JSON 之后是 `Event loop is closed`，然后 `tokio-rt-worker` 报 `panic in a function that cannot unwind` 并 abort。`worker_state` 仍是 PID 3512437、NRestarts 0、active。用户和 `CONTINUATION.md` 把原因写成 Python RTC 探针的 AudioStream 没有 `aclose`，主 Codex 在修。本轮没有读探针源码，不把这个原因写成自己核过的代码结论。旧的功能 PASS 只覆盖到写出 JSON，不覆盖进程退出。

## 证据边界

- 本地 `hickory-source` 只有 `lookup.rs`、`caching_client.rs`、`resolver.rs`、`retry_dns_handle.rs`。没有 `config.rs`，也没有 `Name` 的相等实现。`preserve_intermediates` 默认 true 来自公开 v0.26.3 标签，不是那 4 个离线文件。
- 三份 `TTS_DNS_*_TIMELINE.json` 的记录没有 owner。owner 只在冷批报文里看到。
- 红文件哈希 `ed957308…` 只出现在 `source-dns-cname-additional-red.json`。它不是 `713f6f35` 的 `1b7c945a…`，工作树里也没有这份中间文件。红日志能证明当时那个测试失败；生产旧逻辑以 `713f6f35` 的 41–44 行为准。
- green/red 摘要都是 1 ignored。保存下来的日志正文没有写出被 ignored 的测试名。
- 本轮没有重跑 544/542，没有新的 DNS 捕获，没有检查现网进程。

## 讨论条目

1. 阻断为空，47–69 行可以按现在的选址规则受控部署。
2. 部署说明只写 additional 丢地址，不写 4.7 秒根因。
3. 线上已观察到的 A 应答不依赖这次修复；修复防的是地址只在 additional 的 Lookup。
4. 非阻断 1–2 是测试缺口，不是当前源码错误。
5. 功能 PASS 与进程 `rc=-6` 分开记。
