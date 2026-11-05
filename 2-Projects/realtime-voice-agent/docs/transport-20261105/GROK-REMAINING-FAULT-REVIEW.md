# Grok 对剩余握手与流中停顿的只读复核

会话105，任务81d7b5ec-bd58-4d51-bac1-04d82b1598f0。以下为独立复核原文；主13另行核线上。Grok未审上线后RTC证据；它读取的记录器版本缺少部分关联字段，后续v2已增加匿名room_ref、PID、连接分配/首PCM事件和45秒前窗，见发布回执。其“不是Nagle”应限定为**没有新引入Nagle配置差异的证据**，不能排除旧行为与网络条件共同影响；不能据代码相同宣称历史问题无代码因素。

局部 DNS 修复仍然只解释 i119 那一次 A/AAAA 汇合等待。6075 的 10 秒阶段超时和 t22 的 2922 ms 欠载都还没有可证明的代码根因。

本轮只读了两份文档、`deps-inspect.json` 里两份 tokio-tungstenite 0.30.0 `connect.rs`、`491e068a` 与 `a9cbf9ec` 的 `tts_xfyun.rs` 连接段、当前 `voice_connect.rs` / `StreamTiming` / `network_watch.py`，以及 6075、t22 的既有计时字段。没有改源码、生产或开关。

## 1. 10 秒阶段超时不是新的同步阻塞或连接竞争

6075 在旧线上 `a9cbf9ec` 上发生：`dns_ms=5`，`tcp_ms=64`，`stage=tls_ws`，`outcome=timeout`，`elapsed_ms=10001`，`tls_ws_ms` 为空。TCP 已经返回，剩下的预算耗在 `client_async_tls_with_config` 里。同一窗口没有另一条重叠的 TTS 连接；随后 6076 用 893 ms 连上。

`491e068a` 的握手是同一个 10 秒 `CONNECT_TIMEOUT` 包住 `connect_async`。0.30.0 的实现是 `connect_async_with_config(request, None, false)`：`TcpStream::connect("{domain}:{port}")`，`disable_nagle=false` 时不调用 `set_nodelay`，然后 `client_async_tls_with_config`。`a9cbf9ec` 改成先 `lookup_host`，再 `TcpStream::connect(slice)`，然后仍是 `client_async_tls_with_config(request, socket, None, None)`，也不设 `TCP_NODELAY`。TLS/WS 这一跳没有新的同步调用，也没有第二条握手。`P003_TTS_LATENCY_V1` 在当时进程里不存在，650 ms 备连没有走到。

因此这次 10 秒不是地址竞速，也不是 Nagle。地址顺序若有差别，会记进 `tcp_ms`；这里 TCP 只用了 64 ms。两版共有的是同一条 TLS/WS 握手和原来的 10 秒外层预算。窗口里仍有 LLM/VAD 日志，不像整个运行时被卡死。单线程在 `poll` 里阻塞没有被完全排除，但也没有证据。

当前已注册的 `06eb839d…` 在旗标为 1 时，TCP 前会走 `voice_connect`：两族竞速，每族最多 8 个间隔 250 ms 的连接。那是 6075 之后的路径。它在进入 `tls_ws` 之前结束；若卡在拨号，阶段应是 `resolve_tcp`。它不能解释已经发生的这次 `tls_ws` 超时。

## 2. t22 欠载：现有两条新观测还分不开三种原因

t22 用的是已经成功的 6054：DNS 4 ms、TCP 61 ms、TLS/WS 172 ms、预热等待 0、首 PCM 365 ms。播放侧 3 次欠载共 2922 ms，`first_underrun_ms=597`，`buffered_audio_ms=0`，`played_frames=156`，`SourceDrained`。先前复核记为 7 个 PCM 块、channel 容量 32；本轮没有重数原始日志。欠载表示播放任务正堵在 `recv`，与「channel 已满、发送侧堵在 `send_or_abort`」是队列的两端。以 7 块对 32 格计，这次 2922 ms 对不上 mpsc 打满。历史 t22 没有 `StreamTiming`，这个判断不能用新日志回放。

新日志能分开的只有两截应用等待：

- `max_ws_read_wait_ms` 大、`max_channel_send_wait_ms` 近 0：等待在 `ws.next()`。这里仍混着供应商没送、TCP 没送到、以及任务没被 poll。
- `max_channel_send_wait_ms` 大：本地 channel 背压。`max_observed_pcm_gap_ms` 含着上一帧的发送等待，不能单独当成供应商间隔。
- 只有总和与最大值，没有每段等待的起点。3 次欠载对不齐 3 个包间隔。

`network_watch.py` 只留 IPv4 TCP 头（seq、ack、flags、`data_len`、window、方向）和白名单计时。它能在事后看到同长、同 seq、间隔达到重传量级的重复段，也能看到入站载荷空洞。它没有 `TCP_INFO` 重传计数，没有每帧时间戳，也不解析 TLS。`SAFE_KEYS` 丢掉了 `first_underrun_ms`、`buffered_audio_ms` 和 `room`。包只在启动时的地址集合或两个指定名字的 A 记录里出现过的 IP 上保留；日志里的 `peer` 不会补进这个集合。环容量 16000，事件窗最多 6 个，每个最多 8000 条。IPv6 被以太网类型滤掉。

最少的下一步是等正在跑的 24 小时记录写出第一份 `underrun_ms≥1000` 或 `max_ws_read_wait_ms≥1000` 事件，只做一次拼接：用 `connect_id` 找到 `local/peer`，再看该四元组在读等待区间里的入站 `data_len` 和同 seq 重复；`first_underrun_ms` 要从原始 journal 行读，因为事件文件会丢掉它。若日志里的 peer 在事件里零条 TCP，就是过滤漏包，不能解释成供应商静默。这次 RTC 验收期间不要改记录器、超时或缓冲。

## 3. 没有可直接证明并值得现在修的代码错误

暂停期间的欠载竞态在 `playout.rs` 里是真的：等 `pcm_rx.recv` 时不听 pause，数据到达后会先 `on_wait`。t22 没有暂停记录，出口是 `SourceDrained`，所以它解释不了这 2922 ms，也解释不了 6075。

没有一条代码路径被证明制造了这次 10 秒握手或这次供给空洞。不建议用更大的超时、更大的播放缓冲、未验证的 hedge、预热或 HTTP/2 把它盖住。

实际模型是 Grok（xAI）；本提示没有更细的模型号。未验证：469 项测试没有重跑，没有 SSH，没有看 24 小时记录是否已经双向抓到包，没有重数 t22 的 7 块，也没有读 tokio 1.53.1 的 `TcpStream::connect` 源码。部署注册记录写明新进程 SHA 与 `P003_ASYNC_DNS_V1=1`，RTC 验收结果不在本轮材料里。
