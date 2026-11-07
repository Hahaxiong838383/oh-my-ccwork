我是 xAI 的 Grok 4.7。本轮只读，没有改文件，也没有跑测试。

## 1. 双恢复开关可以加在现有倾听 env 上

上轮“保持现有 env”是收窄上线范围，不是发现兼容缺陷。现役倾听进程已经是 `P003_ASYNC_DNS_V1=1`、`P003_TTS_DNS_HEDGE_V1=1`、`P003_TTS_LATENCY_V1=1`、`P003_TTS_FIRST_PCM_BUDGET_MS=10000`，两个恢复开关为空。只换 `de090103` 时，讯飞 CNAME 和接通失败不再六轮重连会随二进制生效；`take_for_sentence` 和火山 `voice_connect` 不会进入。当时不建议把主池整份 env 抄过来，因为主池是恢复开关为 1、这三项为空。

你现在的做法和计划一致：原项都留，只加 `P003_TTS_CONNECT_RECOVERY_V1=1` 和 `P003_ASR_CONNECT_RECOVERY_V1=1`。代码按这个组合写的。

- `LATENCY=1` 且 TTS 恢复为 1 时，`Prewarm::arm` 不再另开 650ms 预热对冲；650ms 备用和 10 秒前台预算改由 `take_for_sentence` 承担。
- 倾听 `AGENT_NAME=p003-search-listening-20261030` 是候选，所以已有的 10000ms 首 PCM 预算会包住这次获取。`candidate_one_second_first_pcm_deadline_aborts_recovery_prewarm` 锁的就是这条共享截止。
- DNS 对冲只对 `cbm01.cn-huabei-1.xf-yun.com` 生效。ASR 恢复只把 `openspeech.bytedance.com` 的接通切到 `voice_connect`，不会再开一条讯飞 DNS 对冲。
- 接通失败直接结束本次 ASR、不再六连，属于二进制本身；不依赖 ASR 恢复开关。开关额外打开的是火山异步解析。

`source-green-listening-transport-3.json` 的 78 个哈希与本树 `eba80c1f` 逐项一致。相对 `de090103`，运行文件里只有 `src/tts.rs` 多了上述 `cfg(test)` 用例。绿日志 3 是 `604+29+9+7=649`，0 失败。正式二进制 `d627dfa9` 本轮没有重新哈希。

## 2. 这是既有的跨 final 口令缺口，不是本补丁把口令拆碎

反馈口令没有作为一条文本到达解析器。探针在 `t_ms=17912` 收到最后一条 final 后，按 `rtc-probe.py` 的 18 秒条件等到 `t_ms=35550`，失败原因是 `timeout: real feedback audio received`。Worker 日志里没有第二条 `listening.proposal`，没有 feedback 请求，也没有 TTS 接通、发文本或首包 PCM。无声音停在口令未成立，不能记成 TTS 连接失败。

同一条 RTC ASR（`2941185b`，`19:49:51.484` 接通后没有重连）把反馈拆成三段并已发布给客户端：

| 时间 | 段 id | 文本 | final |
|---|---|---|---|
| 15149 | `SG_f970360bc631` | 小可 | true |
| 16244 | `SG_e5b7033fee4b` | 我讲完了 | true |
| 17912 | `SG_54bf9609be00` | 请说说你的看法 | true |

三段间隔 1095ms 和 1668ms，都大于日志里的 `end_window_ms=150`。150 来自现役进程的 `VOLC_ASR_END_WINDOW_MS`，`run_batch.py` 从倾听进程原样拷入；源码默认仍是 800，本补丁没有改这个字段。

解析器对反馈要求整句归一化后与 `小可我讲完了请说说你的看法` 相等，尾字不算。进入口令能过，是因为首句仍在 ordered PCM：两条 final 被 `held_finals.join("")` 收成 9 字，`text_chars=9`，然后才切到 RTC。切到 RTC 之后，每条 `SttEvent::Final` 单独进 `on_final`；对不上就当讲述正文。RTC 路径没有把“小可”这种前缀留到下一条 final。

`listening_voice.rs`、`listening_adapter.rs`、`ordered_pcm.rs` 与 `5b3fdaac` 哈希相同。`5b3..de090` 只有 `voice_connect.rs`、`tts.rs`、`tts_xfyun.rs`、`stt_volc.rs`、`pipeline.rs`。`pipeline.rs` 的运行差异是接通失败不再重试、未使用预连接不发空尾包，以及日志 span。`handle_result` 仍是每条 `definite` 发一个 final。这次反馈流已经发出音频并保持连接，未使用预连接的分支没有走到。`listening-rtc-test` 只放行本机 Brain 地址；进入提案已经完成，它不参与口令拼接。

## 最小下一步

等主 13 的 5b3 feature 二进制、同一 wav、同一 env 的日志，只对三件事：

1. 反馈时段是一条 final，还是同样三个段 id。
2. 有没有第二条 `listening.proposal`。
3. 有没有 TTS 接通或发文本日志。

5b3 若同样是三段 final、没有第二条提案、没有 TTS 行，缺口就在 5b3 已有的解析路径上，运输补丁不用改。若 5b3 收到一条完整口令并发出反馈提案，再只对比两条 ASR 从接通到这三条 definite 的时间；解析文件已经逐字节相同。
