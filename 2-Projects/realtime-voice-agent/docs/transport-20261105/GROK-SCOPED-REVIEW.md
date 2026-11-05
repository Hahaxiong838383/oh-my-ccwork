# Grok 局部修复复核（会话104）

这条 A/AAAA 汇合等待，对 i119 这一次成立。窄修对应该机制。本树这份补丁未见代码阻断。主 13 若只发布这条 DNS 局部修复，并写明 TLS 10 秒预算、历史 5 秒、流中停顿都未根治，该范围与证据相符；上轮「整体通过」仍然没有依据。这次抓包没有出现 5 秒，不能把未复现写成已经证实或已经修复。

1) i119 的等待有报文闭合。`dns-capture.json` 有 240 次 getaddrinfo，`capture_errors` 为空，最大就是 i119 的 397.582 ms，次大 69.937 ms（i178）。i119 起点 `1793886008.7984724`。同一本地端口 38278 先发 type=1（dns_id 20060）和 type=28（dns_id 20512）到 `127.0.0.53`。A 在 `1793886008.8078263` 回到本进程，rcode 0、answers 7，距起点 9.354 ms。AAAA 在 `1793886009.1958423` 才以同一 dns_id 20512 回到本进程，rcode 0、answers 1。两者相距 388.016 ms。getaddrinfo 终点比这条 AAAA 晚约 0.212 ms。上游 `8.8.8.8` 的 type=28 在 `1793886009.193247`，随后 `hb-kaicp.xf-gtm.com` 的 type=28 在 `1793886009.1953268`、answers 0。header 没有 rdata，CNAME 是文档归纳，与这个 qname 顺序相符。紧邻的 i118 用端口 57987，A/AAAA 都在约 8 ms 内返回，getaddrinfo 为 9.025 ms，同样是等较晚的一族结束后才返回。因此能确认的是：这次 AF_UNSPEC getaddrinfo 在 A 已经回到本进程后，继续等 AAAA。历史 5 秒、5011/5014 是否同源，这份材料没有证明。

2) 窄修对上的是这一层，范围也守住了。`git diff` 只有 `tts_xfyun.rs`（+97/−9）。`P003_ASYNC_DNS_V1` 必须精确为 `1`，且 agent 为 `rust-worker` 或既有 search canary，且 host 精确等于 `cbm01.cn-huabei-1.xf-yun.com`，才走既有 `voice_connect::connect`。该函数分族查询，`select` 在任一族成功后返回，A 成功不等待缺失的 AAAA；IPv6 仍在 50 ms 后作为独立候选，既有 r16 覆盖「A 不等 AAAA」和「IPv6 仍可用」。默认未设 flag 时仍是 `lookup_host` 加系统 TCP。`TTS_URL` 的 host 与闸门一致。TLS 仍是 `client_async_tls_with_config(request, socket, None, None)`，整体预算仍是 `CONNECT_TIMEOUT` 10 秒。预热龄期、只握手不发文本、`build_request` 逐句 payload 都没有改。diff 没有移植 upstream hedge。local/peer 在 TLS 前写入并随连接 Drop 打出。收流等待、`channel_send` 等待分开累计。取消和错误在 `completed=false` 时由 Drop 退出；成功才是 `completed=true`。这些日志不改变 10 秒预算、30 秒收流超时或取消时仍返回 `Ok` 的原行为。

3) 未见代码阻断。本树 `tts_xfyun.rs` 的 SHA-256 是 `1c2b02fb9bf4091e0c9da794cdd017cea9ec648518a9be4b6bb6c8a0c540a9dd`，`voice_connect.rs` 是 `1b7c945a2d8f5b9827022d8d6725502d020dd939fbc0676a7766daca10dace2a`，与 `worker-final.log` 记录的 source sha 一致。该日志是 final、rc 0，469 passed、0 failed，其中包含两个新测试名和三条既有 r16。我这轮没有重跑测试。日志里没有 red 过程，也没有 release 构建结果。flag 打开后，解析失败域改为既有 hickory（超时 1 秒、尝试 2 次），仍包在同一个 10 秒预算里。两个新测试只锁布尔闸门，分族竞速的执行证据在既有 `voice_connect` 测试，不在这两个新测试里。

4) 主 13 只发布这条局部修复，并明确 TLS 10 秒、历史 5 秒、流中停顿未根治，与 i119 和补丁范围一致，也与「上轮整体通过没有依据」一致。局部修复成立，整体根治不成立。这 240 次的最大值是 397.582 ms。

Grok，xAI
