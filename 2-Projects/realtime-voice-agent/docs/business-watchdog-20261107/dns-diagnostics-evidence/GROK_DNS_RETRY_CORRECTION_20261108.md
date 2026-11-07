模型：Grok 4.7。结论：接受这组纠正。

177 的「3 次 send、约 3 秒、5 查询凑 4700ms」里，3 次是 `attempts=2` 的逻辑重试（`retry_dns_handle.rs`：remaining 从 2 减到 0 再失败）。UDP 在每次逻辑发送内另计。`udp_client_stream.rs` 用 `FuturesUnordered` 重发，`max_retries` 默认 3，间隔为 `max(retry_interval, DEFAULT_RETRY_FLOOR)`，外层是 `Timer::timeout(self.timeout)`。`connection_provider.rs:85-94` 把 `options.timeout` 经 `with_timeout(Some(_))` 传入；`name_server_pool.rs:313` 还有同一秒的池级 deadline，间隔取 `1.2×decayed_srtt`。1 秒已经进入下层。177 只读的四份上层文件不拷贝 timeout，这点仍成立；传输层是否生效，由本次实验补上。

同 Hickory 0.26.3 离线：v1 按 5 查询假设失败，334ms 即重发，3003ms 仍停在 `slow.example.`。v2 固定 9+6，因 SRTT 自适应失败（5862ms，`success=false`）。v3 按首包起 2800/1900ms 回包，且回包不堵住收包：CNAME 4705ms 成功，13 个 UDP、2 个 qname；直接 A 2805ms 成功、9 查询；全静默 3003ms 失败、9 查询。单名上界仍约 3 秒，串行 CNAME 可以累加超过 3 秒。这只证明客户端机制，不能倒推历史 4704ms。丢包、调度、上游都没有证据。

先部署已经过测试的原因诊断，总预算和并发保持不动。下次取证按同一连接对齐查询 id、源端口、qname 和逻辑尝试序号。不能无证据改 DNS 或砍预算。本轮未重跑诊断测试，未重审 72053。

夹具限制：`dns_retry_budget_v3.rs:48-51` 只断言宽时间窗，没有锁住 9/13 包，以三份日志 JSON 为准。`:30-38` 一到点就向 pending 里每个旧 peer 回包，而同一 id 的源端口每次都变。`:32` 的 2800/1900ms 是夹具墙钟，不是上游时延。
