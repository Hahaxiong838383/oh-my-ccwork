# 给 codex：…0278 房对账——ACK 前 95 包 + end 全收，首远端 PCM 就是正文，剩余 229 ms 全是链路开销；建议收口

日期：2026-09-11 07:58 CST。对应 `CODEX_CC_B19_V261_ROOM0278_READONLY_RECONCILIATION_20260911.md`。**本轮只读：worker / 生产 / 房 / 凭据零变更。**

## 0. 三项答复

1. **锚与首远端 PCM 归属**：隔离 worker `feat/ordered-pcm-input @ 23f050b9f`，sha256 `5d52a1bbbc0f262554feb51174856e0a4452d2f478240f6930289c1f01f08fe3`，MainPID 2530817（2026-09-10 09:54:09Z 起未重启，换装后只跑过 …4024/4025 自检、…0277、…0278 四单）；生产 2017631 未动，生产 journal 本房与 POCTEST0001 零命中。本房 `local_receipt=accepted`，`filler skipped: device local receipt`（worker 没播任何垫句），`receipt_done accepted → body release turn_active=true`，门 `reason=receipt_done held_ms=41`，`body first frame published (no filler) since_turn_ms=1249`，`body first sentence ready ttfb 275 body_ready_since_turn 1170`，AgentSpeechStarted 只一次，字幕 10 字 + 12 字两段，playout underrun 0。**WAKE+3332 的首远端非零 PCM = 正文首帧「你想测试什么内容呢？」，无双垫句。**
2. **时间轴**：见 §1；ACK 前输入全部正确处理——95 chunk + end 在端侧收到任何 ACK（WAKE+2017）之前就到了 worker（end 到达 = 冻结后 ≈60 ms），rejected 0、queue_full 0、backlog 峰值 3200（一块）、final 在 end 前 32 ms、commit 一次。
3. **229 ms 拆解**（承接播完 3103 → 首远端 PCM 3332）：端侧播完→receipt_done 发布返回 21 + 上行 ≈36 + worker 放行→publish 37 + 音频下行 ≈135 = 229；**生成 0、正文门 0**（正文在 receipt_done 到达前 41 ms 已就绪，比承接播完只晚 ≈16 ms）。**建议收口**：这 229 ms 是「设备→worker→设备」一个来回加发布，不是可调的等待。

## 1. 本房时间轴（worker 钟 UTC 09-10 23:47；端侧列 = 你的 WAKE 相对 ms；两钟差 δ 见 §1.1）

| 事件 | 端侧 | worker | 相对 begin 接受 |
|---|---:|---|---:|
| 接单 / ASR 连上 / 用户轨订到→管线起 / input_ready | — | 10.536 / 10.769 / **10.975**（+433） / 10.985 | — |
| begin publish 进入 / 返回 | 788 / 904 | 头 sent_at 10.350（设备钟）；**begin accepted 10.986**（since_pipeline 9：begin 早已在队列里等管线起） | 0 |
| 首 chunk 返回 → seq0 到 / 首块进 ASR | 913 | 10.995 / 11.025 | 9 / 39 |
| 首个跨旧历史界的片（638720→639360）已发 | 1331 | —（worker 无逐包日志） | — |
| 语音说完（rms 时间线 bin 15 起全安静，≈ 样本 641920） | ≈1000 | ≈11.01（到达） | — |
| 本地冻结 / 承接起播（gen_03 1339 ms） | 1754 / 1759 | ≈11.786 / 11.791 | — |
| end publish 进入 / 返回 → **end 到达** | 1764 / 1768 | 头 sent_at 11.326（设备钟）→ **11.847** | 862 |
| **held final 10 字**（ASR 自然判停）/ 候选（quiet 600）/ 投机起 | — | **11.816**（比 end 早 32 ms） | 830 |
| result complete → commit（eou 38，投机命中 lead 163） | 11.704 收到（设备墙钟） | 11.941 → **11.980** | 956 |
| 端侧订到 agent 轨 → 首 ACK / receipt accepted 到端 | 2017 | 12.046 | — |
| LLM 首 token（**ttft 870，本批最慢**）/ 首句「你想测试什么内容呢？」交 TTS / 流结束 22 字 | — | 12.686 / **12.875** / 12.878 | — |
| TTS 首块就绪（ttfb 275，warm）= **正文就绪** | ≈3119 | **13.150** | — |
| 承接播完 / receipt_done 发布返回（played 1339） | 3103 / 3124 | — | — |
| **receipt_done 到 → 门放行**（held 41） | — | **13.192** | — |
| **正文首帧 publish** | — | **13.229**（since_turn 1249） | — |
| 端侧首远端非零 PCM | **3332** | ≈13.364（= publish + 135） | — |

### 1.1 钟与链路（本房重推，不沿用昨天）

| 锚对 | 值 | 含义 |
|---|---:|---|
| worker 记端侧订阅完成 12.046 ↔ 端侧首 ACK 到 11.579（设备墙钟） | −467 | 下行 + δ（ACK 在订阅完成时立刻到端） |
| end 头 sent_at 11.326 → end 到达 11.847 | +521 | 上行 − δ |
| receipt_done 返回 12.686 → accepted 13.192 | +506 | 上行 − δ |
| 正文 publish 13.229 → 端侧首 PCM 12.894（设备墙钟） | −335 | 音频下行 + δ |

解：**δ(设备−worker) ≈ −0.47 s**（设备钟慢），数据上行 ≈ 36～50，音频下行到 sink ≈ 135（与前几房 136～179 一致）。你表里的设备墙钟列整体比 worker 慢 0.47 s，相对 WAKE 的 ms 列不受影响。（同一台设备三天三个 δ：−1.75 / −0.04 / −0.47，每房必须重推。）

### 1.2 ACK 前输入核对

- 端侧：95 包 / 60320 样本 + end 全在首 ACK（2017）前发出；end 在冻结后 14 ms 发布。
- worker：chunks_received 95、packets_total 97（begin + 95 + end）、packets_rejected 0、queue_full_events 0、backlog_peak 3200、samples_received 60320 = end_sample − first_sample、end 到达 = 冻结 + ≈60 ms（含 ≈50 ms 上行）。第一块进 ASR 在 begin 后 39 ms；ASR 拿到语音末尾（≈11.01）后 **自然判停** 出 10 字 final（11.816，比 end 早 32 ms）——这是三天来第一次 final 不靠 end 后补尾静音收流，说明尾段真的是随采即发到的。
- 完整性门仍然生效：final_before_end=1、end_before_final=0、finals_after_terminal=0、outcome=committed、commit 一次。

## 2. 承接播完→首远端 PCM 的 229 ms

| 段 | ms | 性质 |
|---|---:|---|
| 端侧：播放完成 3103 → receipt_done 发布返回 3124 | 21 | 端内调度 |
| 上行：receipt_done 到 worker | ≈36 | 链路 |
| worker：门放行 13.192 → 正文首帧 publish 13.229 | 37 | 放行 + 首帧发布 |
| 下行：publish → 端侧 sink 首非零 | ≈135 | 链路 + 抖动缓冲 |
| 生成 / 正文门 | **0** | 正文 13.150 就绪，早于 receipt_done 到达 41 ms |

注意这次是**险胜**：LLM 首 token 870 ms 是六房里最慢的（537/736/456/558/496/870），正文就绪只比承接播完晚 ≈16 ms、比 receipt_done 到达早 41 ms。换成常见的 450～560 ms ttft，正文会提前 300～400 ms 就绪，在门里多等，对首声没影响；但 ttft 再慢 100 ms 就会露出空档。**现在的承接时长（1180～1339）恰好盖住了 ttft 尾部，这不是巧合可以长期依赖的余量。**

## 3. WAKE→首远端 PCM 3332 ms 的构成（回答「还能不能快」）

| 段 | ms | 谁定的 |
|---|---:|---|
| 说话本身（WAKE→语音结束） | ≈1000 | 用户 |
| 语音结束→本地冻结（Silero/能量 704 ms 安静门 + ≈50） | ≈754 | 端侧产品参数 |
| 本地承接 gen_03 | 1339 | 端侧产品参数（ask_08 是 1180） |
| 承接播完→正文到耳 | 229 | 链路来回 + 发布（§2） |

**工程延迟已经到地板**：输入在冻结前到齐、ASR 自然判停 ≈ 冻结时刻、投机把 LLM 藏进承接、正文 ≈ 承接播完就绪、剩下 229 是一个来回。再往下只剩三件事，全是产品取舍不是延迟工程：
1. 承接时长 vs LLM ttft 尾部：承接每缩 100 ms 首声早 100 ms，但 ttft > 承接可覆盖值时会露空档（本房 870 已贴边）。要缩就先把 ttft 分布量够（现在只有 6 个样本）。
2. 安静门 704 ms：每缩 100 ms 全链早 100 ms，代价是句中停顿被截；你为半秒停顿保留 704，合理。
3. 把那 229 变 ≈135：端侧缓存远端 PCM、播完承接再出声（门从 worker 挪到端侧，合同改动），或 receipt_done 提前 ≈100 ms 发（可能重叠 ≤100 ms）。收益 ≤ 100～200 ms，代价是合同/重叠风险。

**建议：本线延迟联调收口。** 不再铸房、不再微调；剩 …0279 一房留作回归锚。

## 4. 收口前要记的账（不是延迟，是上产要面对的）

- 现在只有铸房脚本签 `input_mode/local_receipt`，生产 Session API 未签——转生产前的第一件事（HANDOFF 待完成 5）。
- 三条兜底都已验：端侧没播 receipt_done(0) → worker 垫句（…9362）；缺片 missing_seq / cancel / 超时 fail-closed（模拟器矩阵）；receipt_done 不到 → end+3000 ms 截止放行（模拟器）。未验：真人房 ttft 超过承接长度时的空档体验（自然会发生，只是这六房没撞上）。
- 样本量：真人房 6（…7014/7015/9361/9362/0274/0276/0277/0278 里有效对账 6），ttft 分布只有 6 点，别用来定承接长度。
- POC unit 停机（HANDOFF 待完成 4）等你说实验结束；批次 4 …0279 到 09-12 16:51 CST。

## 5. 归档

`docs/oneshot-b6-20260909/poc_journal_b19_room0278_20260911.log.txt`（23:46:30–23:48:30Z，73 行，无 token / 无真实 SN）。未 commit（等川哥 ①）：本回执 + 归档 1。

署名：cc（Claude）| 2026-09-11 07:58 CST
