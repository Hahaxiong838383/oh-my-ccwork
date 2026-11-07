# TTS DNS 假设（2026-11-08，只读）

模型：Grok 4.7（xAI）。本轮只审查新的同连接 TTS DNS 证据，不重开已上线 ASR `713f6f35` / 主池 `3dd0430a`，不回退。

HEAD `b97113001b59cd30d8357dbe235a8e67a759c8db`。`voice_connect.rs`、`tts.rs`、`tts_xfyun.rs` 与 `713f6f35` 无差异。工作区仅有未跟踪的 `rust-worker/examples/`，未使用。未改代码，未发 probe，未 SSH，未联网安装依赖。下面的区分实验留给主 13 的同一次 DNS 元数据捕获，本轮不执行，避免抢同一次实验。

## 同一次调用（journal `8383a641…`，room `…1794073741651` turn 2）

| 时刻 (UTC) | 事件 |
| --- | --- |
| 17:49:06.611 | connect_id=1 开始，448ms 后 `resolve_tcp/cancelled`。future 在出结果前被丢掉，不是解析失败。 |
| 17:49:07.060 | connect_id=2 开始。结束于 17:49:11.986：`connected`，`dns_ms=4704 tcp_ms=51 tls_ws_ms=170 elapsed_ms=4926`，`dns_path=independent_families`，peer `123.56.17.44:443`。 |
| 17:49:08.026 左右 | 前台开始等这条预热。`prewarm_wait_ms=3961`，4926−3961=965ms 已在等待前跑过。 |
| 17:49:08.677 | 日志 `bounded spare started`（只存在于 `recover_connection`，650ms）。connect_id=3 随即开始。 |
| 17:49:09.064 | connect_id=3：`resolve_tcp/failed elapsed_ms=386`，`local=None peer=None`。无 `dns_ms`。 |
| 17:49:11.986 | connect_id=2 交给本句。`provider_ttfb_ms=560`，`first_pcm_ms=4521`，metrics `ttfb_ms=4521`。 |
| 17:49:12.208 | connect_id=4：`dns_ms=0 tcp_ms=51`，同一 peer。 |
| 17:50:22 | 下一轮 connect_id=5：`dns_ms=188`，peer 换成 `39.105.54.181:443`；随后 6、7 为 `dns_ms=0`。对照，不是本轮相减。 |

4704+51+170=4925，与 elapsed 4926 差 1ms。慢的是胜出族的 `lookup`，不是 TCP，也不是 TLS。

`dns_ms` 在 `family()` 内、从 `lookup` 到筛出地址为止。peer 是 IPv4，所以这 4704ms 是 A 查询，不是 AAAA，也不是两族相加。AAAA 晚 50ms 启动，不计入这条 `dns_ms`。两族 `select` 在胜者成功时直接返回。

备用失败时，connect_id=2 的 A 查询大约还剩 2.7s。`dial()` 只有两族都返回 `Err` 才失败，因此 connect_id=3 的 A 和 AAAA 都在 386ms 内结束。它没有等着 connect_id=2 那条仍未完成的 A future。

`resolve_tcp` 在 `connect()` 返回 `Ok` 之前不会改阶段。`resolve_failed`、空地址导致的 `connect_failed`、TCP 失败，日志都是同一行。`family()` 把 lookup 错误收成没有 rcode 的 `resolve_failed`。`recover_connection` 在主连接还活着时用 `Err(_)` 丢掉备用错误。这份 extract 里没有 reason，再读同一份 journal 也补不出 rcode。`local=None` 只说明没有成功套接字；TCP 尝试过仍会是 None。

386ms 低于代码里的 1s timeout、650ms hedge、500ms 的第三地址档。它不是这些常量本身。若失败发生在 `addresses_connect`：第三档要先睡 500ms，386ms 时收不完，所以当时最多尝试了 2 个地址。若失败发生在 lookup，地址个数不适用。

## 源码边界

已读应用代码：进程内 `OnceLock` 共享一个 `TokioResolver`；`timeout=1s`，`attempts=2`；A 与 AAAA 分开 `lookup`；只保留对应族的地址；空列表走 `connect_failed`。仓库测试证明：mock 直接返回 A 时，沉默的 AAAA 不挡住成功，TTL 内第二次 dial 不再发 A 查询。该测试没有证明 timeout 会在 1s 或 2s 终止 lookup。

本地没有 `hickory-resolver 0.26.3` / `hickory-proto 0.26.3` 源码或 crate 包（`~/.cargo/registry` 无此目录）。以下因此标缺，不写成已读结论：`attempts` 是总次数还是额外重试、timeout 是否为 lookup 硬截止、CNAME 追赶、search 后缀、UDP 失败后是否再试 TCP、在途查询是否合并。即便 `attempts=2` 表示一共 3 次，3×1s 仍小于 4704ms，单次查询的 1s 预算仍解释不了这次成功返回。

系统解析器：`DNS_RESOLVER_STATE` 为 systemd 255 stub；`DNS_UPSTREAM_MATRIX` 里 dig 的 `SERVER: 127.0.0.53` 只证明当时系统解析器是 stub。上游名单是 8.8.8.8 与 1.1.1.1，位于 stub 后面，不是 hickory 的 nameserver 列表。hickory 读到的 stub 文件正文（search、options）没有入库。`/run/systemd/resolve/resolv.conf` 的 `search .` 是直连上游文件，不能当成 stub 文件。16:59 已启用 `Cache=yes`。当时 cache 转储里没有 `cbm01.cn-huabei-1.xf-yun.com`。

`DNS_UPSTREAM_MATRIX` 的时延、A 记录、AAAA NODATA、voice-hk 的 TTL 只属于 `voice-hk.hahaxiong.cc`，不套用到讯飞域名。openspeech 的 CNAME 链同样是另一个名字。16:56 的 “Total Timeouts: 70” 是更早的累计值，不是这次查询。没有这次查询的 DNS 包，不能写成上游丢包，也不能写成安卓问题。这条路径的本地地址是 `64.90.13.177`。

## 假设

### H1. 这一次 A 查询只向 stub 发了一次，答案在 4704ms 被接受；1s×2 没有成为这次 lookup 的截止

支持：返回的是成功和 A 记录，不是超时错误。connect_id=5 的同路径 A 查询 188ms 就成功，说明有响应时不会凑满 1s。4704>2000，也大于 3×1000。hickory 只看见 stub；stub 自己找 8.8.8.8 / 1.1.1.1 的时间可以长于客户端名义 timeout，但只有客户端没在 1s 放弃时，成功时刻才会落在 4.7s。

反证：应用代码确实在 `build()` 前写了 `timeout=1s` 和 `attempts=2`。若该截止生效且 lookup 只含一次查询，客户端应在约 2s（或 3s）失败，而不是在 4.7s 成功。crate 源码缺失，不能判定这两个字段有没有进入这次 `lookup`。只有一个慢样本。

实验（主 13，本轮未做）：冷查询 `cbm01.cn-huabei-1.xf-yun.com` 的 A，同时记客户端发往 `127.0.0.53` 的查询时刻、id、响应时刻与 rcode。恰好一发一收且响应在约 4.7s：H1 成立。约每 1s 一发：H1 不成立，改看 H2。

### H2. 同一次 `lookup(A)` 里有多段串行查询，最后一段的成功时刻加总为 4704ms

支持：4704 落在 4×1s 再加几百毫秒一带。单查询的 2×1s 或 3×1s 都不够，差额只能来自额外的串行段：同一 qname 的更多次尝试、CNAME 目标上的后续查询、search 后缀，或每次 UDP 超时后再开的 TCP。`family()` 会丢掉非 A 记录；若库在内部看到只有 CNAME 就再查一次，时间会算进这一个 `dns_ms`。这段内部行为源码缺失。

反证：没有任何 `cbm01.cn-huabei-1.xf-yun.com` 的 CNAME、search 后缀或分段查询记录。其他域名的 CNAME / NODATA 不能挪过来。仓库测试在 mock 直接给 A 时只看到一次 A 查询，该 mock 没有 CNAME。connect_id=5 证明这条代码路径也可以在 188ms 结束，4.7s 不是固定重试栈。

实验：与 H1 同一次捕获，列出每个查询的 qname、qtype、传输（UDP/TCP）和应答段类型。qname 变化：search 或 CNAME 追赶。qname 不变且间隔约 1s：重试。始终只有一个查询：H2 不成立。

### H3. connect_id=3 的 386ms 是两族都已结束的失败，不是 1s 超时，也不是挂在 connect_id=2 的在途 A 上

支持：386<1000；`outcome=failed` 不是 `cancelled`。`dial` 的失败要等 A 与 AAAA 都失败。当时 connect_id=2 的胜出 A 查询尚未完成，所以两边不是同一个还在等的 future。备用开始于主连接已跑约 1.6s 之后、正向缓存写入之前；`Err(_)` 把具体错误丢了。

反证：现有日志分不开 `resolve_failed` 与 `connect_failed`。386ms 同样符合「lookup 已返回 1～2 个地址，TCP 快速失败」；第三档地址来不及。不能指定 SERVFAIL、REFUSED、NXDOMAIN、NODATA 或 CNAME-only 中的哪一个。也没有包证明 stub 对并发查询给了不同 rcode。

实验：不要从这份 timing 行里找 reason，代码没记。主 13 把 17:49:08.678–09.064 这 386ms 窗口和 stub 应答对齐。窗口内已有 rcode、NODATA，或 NOERROR 但答案被 `family()` 滤空：失败在 DNS 结果。窗口内 NOERROR 且带 A，随后这些地址 TCP 被拒：失败在 TCP。窗口结束时该备用的 A 查询仍无响应：H3 不成立。

### H4. 共享 resolver 的正向缓存解释得了紧接着的 dns_ms=0，解释不了 4704，也没帮上备用

支持：一个进程一把 `TokioResolver`。connect_id=2 成功后约 222ms，connect_id=4 `dns_ms=0` 且连到同一 peer，与仓库 TTL 测试的「第二次不再查询」一致。connect_id=3 跑在这次写入之前。70s 后 connect_id=5 又是 `dns_ms=188` 且 peer 不同，缓存不是永久钉死。两路并发结果不同，排除「connect_id=2 在等 connect_id=3 持有的锁」：锁会推迟先结束的那一路，不会让备用先失败、主查询继续慢到 4.7s。

反证：缓存未命中只说明开始时没有可用正向项，不说明 stub 为什么 4.7s 才回答。日志只有连上的 peer，没有完整地址集合；`123.56.17.44` 与 `39.105.54.181` 可能是同一次 RRset 的轮换，也可能是两次不同应答。connect_id=3 是否在重叠的几秒内写入过负缓存，成功后又被覆盖，日志看不见。`Cache=yes` 作用于 stub，不是这把 hickory 缓存；connect_id=4 的 0ms 发生在 hickory 侧。

实验：同一次冷查询期间，在三段时刻看这个 qname 的 A/AAAA 缓存项与 TTL：connect_id=2 等待中、connect_id=3 失败时、connect_id=2 成功后。成功前没有 A、成功后才出现：证实这次是写入前的未命中。重叠窗口出现负项、成功后消失：瞬时负缓存成立。不要为这个实验再打一轮业务流量。

## 不能成立的读法

- 跨轮相减：4704 是 connect_id=2 自己的 `dns_ms` 字段。
- 4.7s 的 TLS 或 TCP：这两段是 170ms 和 51ms。
- 把 4704 当成 A 等 AAAA：胜出 peer 是 IPv4，时钟在 A 的 `lookup` 内。先前 LiveKit / voice-hk 的「AAAA NODATA 拖住整次 getaddrinfo」是另一个名字、另一条系统解析路径。
- 用 voice-hk 矩阵的 0–839ms、AAAA SOA、或 openspeech CNAME 链解释 `cbm01.cn-huabei-1.xf-yun.com`。
- 把未捕获的包写成 8.8.8.8 或 1.1.1.1 丢包，或写成安卓网络问题。
- 把 connect_id=1 的 `cancelled/448ms` 当成一次 DNS 超时。
