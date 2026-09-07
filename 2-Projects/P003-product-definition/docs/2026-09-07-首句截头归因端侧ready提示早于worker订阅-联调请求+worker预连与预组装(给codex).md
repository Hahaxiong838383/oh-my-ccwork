# CC → codex：真人首句截头（「说个长句测试一下」→「去测试一下」）——归因「端侧 ready 提示早于 worker 订阅到麦克风轨」，请端侧把提示挂回 input_ready；worker 侧已做 ASR 预连 + pipeline 预组装

日期：2026-09-07 07:47 CST。对象 `BJP00326070804800006`（exact v237）。本文只谈**首句截头**这一条新问题；播报中语音退出、回声门、5 秒 idle 均已双端收口，不重开。
证据标签：§1 为 64.90 worker journal 实读（UTC 换算 CST）；§2 归因为**推断**，端侧时序需 codex 用设备钟核；§3 为 worker 已部署真值。

## 0. 结论

- 07:37–07:39 真人 6 房，5 房说了首句，其中 **3 房首句被截了头**：转写「去测试一下」×2、「长距测试一下」（原话「说个长句测试一下」）。这 3 房的 worker VAD 起点都在输入环启动后 **+57–60 ms**——worker 一开听你已经在说，而且开头的字已经说过去了。2 房完整的（「说个长句测试一下」）VAD 起点分别在 +535 ms 和 +3.8 s——用户开口晚于 worker 开听。
- **不是 ASR 握手**：ASR 预连 07:35 已上产，6 房 `asr: connected` 领先输入环 0.6–1.7 s（§3.1）。订阅到麦克风轨之前的语音 worker 收不到（LiveKit 不给订阅者补历史帧），与 ASR 是否连好无关。
- **推断根因**：v237 把 UI「可以说了」提示改为**提示音播完 +200 ms 即发**（codex v237 交接 §3.3），而设备发布麦克风轨 → worker 订阅到轨仍需 ~0.5–1 s（worker 侧 `user_track_subscribed` 在 assignment 后 944–2030 ms）。用户按提示开口时 worker 还没在听。这是 v236→v237「提示音播完才开麦 + 立即 ready」改动的副作用，不是回声/回灌回归。
- **请端侧**：UI「可以说了」提示改挂在 worker `session.input_ready` 到达之后（或至少 agent 已订阅麦克风轨的事件之后）；麦克风照旧提示音播完就开（保住回灌修复），只是提示别抢在 worker 前面。**不动 input_ready 合同、不加信令字段**，只改端侧提示时机。
- **worker 侧已做**：① ASR 预连提前到建房阶段（07:35 上产，§3.1）；② pipeline 预组装——VAD 模型/填充语库/声纹库/LLM·TTS 客户端与预热全部在 assignment 到达即开始，与建房并行，订到音轨后直接接管（§3.2）。两项把 worker 自己能压的都压了：订到轨 → 开始听从 176–337 ms 压到 待下一轮真机实测（预期 <50 ms）。剩下的空窗完全是设备发布轨 → worker 订阅的网络/协议时间 + 端侧提示时机。

## 1. 证据（worker journal，CST）

| 房（尾） | assignment→订到麦克风轨 | 订到轨→输入环 | 首句 VAD 起点（相对输入环） | 首句转写 | 判定 |
|---|---:|---:|---:|---|---|
| …7880 | 967 ms | 213 ms | +535 ms | 说个长句测试一下 | 完整 |
| …7899 | 1692 ms | 237 ms | +3.8 s | 说个长句测试一下 | 完整 |
| …7917 | 981 ms | 178 ms | **+60 ms** | 长距测试一下 | 截头（「说个」丢）+ 近音错转 |
| …7930 | 985 ms | 216 ms | **+58 ms** | 去测试一下 | 截头（「说个长」丢，「句」→「去」） |
| …7943 | 944 ms | 176 ms | **+57 ms** | 去测试一下 | 截头 |

今早 07:18 的 …6710 房（预连前）同形：VAD +51 ms 的首段无转写，用户重说才提交；…6732 房 +104 ms 却完整——截多少取决于开口时刻与 worker 订阅到轨的相对位置，不是固定值。

worker 收到首帧就发 `session.input_ready`（合同：PCM 真在流动才算就绪），所以 input_ready 是「worker 真在听」的最早可靠信号；提示音播完那一刻 worker 大概率还没订到轨。

## 2. 请 codex 核对与实施

1. 用设备钟给出上述 3 房的：提示音结束 → UI ready 提示显示 → 麦克风轨 publish → 收到 worker `session.input_ready` 的时刻，确认提示确实早于 input_ready ~0.5–1 s。
2. 若成立：把 UI「可以说了」挂到 `session.input_ready`（或 fallback 超时）之后再显示；麦克风开启时机不变。这就是 v236 之前的挂法，只是麦克风不再提前开。
3. 验收：真人提示一出就说「说个长句测试一下」×3，worker 侧 3/3 转写完整（无截头），且 VAD 起点相对输入环 ≥ +200 ms。
4. 边界：不改 input_ready 合同、不改芯片命令合同、不重开回声矩阵；worker 不再为此改动。

## 3. worker 已部署真值

### 3.1 ASR 预连（feat/rust-worker `a1acbf517`，07:35:50 CST 换装）

| 房 | 预连 spawn→`asr: connected` | 领先 `input_loop_started` |
|---|---:|---:|
| …7868 | 679 ms | 1.69 s |
| …7880 | 453 ms | 0.73 s |
| …7899 | 511 ms | 1.42 s |
| …7917 | 295 ms | 0.86 s |
| …7930 | 596 ms | 0.61 s |
| …7943 | 391 ms | 0.73 s |

### 3.2 pipeline 预组装（feat/rust-worker `3a2af41c3`，2026-09-07 07:49:55 CST（23:49:55 UTC） 换装）

- job 收到 assignment 即起 `prebuild`：ASR 预连 → 配置 → LLM/TTS 客户端与预热 → 回声对撞库拉取 → 在 blocking 线程加载 VAD 模型、填充语库（93 条）、声纹注册库；建房/发布出声轨/等用户音轨与之并行；订到轨后 pipeline 直接接管 `Prebuilt`。无预组装路径（web 调试直连）原地组装，行为一致。
- 现役二进制 sha256 前 16 `f3707e7eae7e3a42`，MainPID 2017631，env 未动，回滚 `voice-rust-worker.bak-20260906-234953（= 预连版 1d8f0b75…）`。
- 验收锚：`pipeline prebuilt`（含 elapsed_ms）早于 `user_track_subscribed`；`track_to_input_loop_ms` 从 176–337 降到 待下一轮真机实测（预期 <50 ms）；不再出现 `native audio stream queue overflow; dropped N queued frames`（此前组装期间麦克风帧排队溢出丢帧）。

状态：**FIRST_SENTENCE_HEAD_CLIP_CAUSE_INFERRED(device ready cue precedes agent subscription) / WORKER_ASR_PRECONNECT_LIVE / WORKER_PIPELINE_PREBUILD_LIVE / DEVICE_ACTION_REQUESTED(gate ready cue on input_ready)**

署名：cc（Claude）| 2026-09-07 07:47 CST

## 4. 增量（2026-09-07 08:09 CST）：预组装真机 6 房实测 + 川哥拍板方向「唤醒即并行建房/发轨，worker 屏蔽本地招呼语」

### 4.1 预组装生效（08:02–08:04，worker journal）

| 房（尾） | accept→`pipeline prebuilt` | accept→订到麦克风轨 | 订到轨→输入环（`track_to_input_loop_ms`） | 首句 VAD 起点（相对输入环） | 首句转写 |
|---|---:|---:|---:|---:|---|
| …9356 | 358 ms | 2005 ms | **213 ms**（换装后首个 job，二进制页缓存冷；有 1 条 overflow 丢帧） | +2.65 s | 退出 |
| …9370 | 314 ms | 1745 ms | **13 ms** | +145 ms | 一下（截头） |
| …9388 | 287 ms | 964 ms | **3 ms** | +1.85 s | 退出 |
| …9399 | 295 ms | 1728 ms | **4 ms** | +4.6 s | 小可小可 |
| …9418 | 236 ms | 1724 ms | **2 ms** | +286 ms | 说个长句测试一下（完整） |
| …9435 | 239 ms | 1618 ms | **7 ms** | +253 ms | 你去测试一下（截头/错转） |

- 订到轨 → 开始听：176–337 ms → **2–13 ms**（首个 job 213 ms 是新二进制冷页缓存，之后消失）；组装期麦克风帧溢出丢帧只在首个 job 出现 1 次。ASR 预连 6/6 早于音轨 0.4–1.6 s。播报中语音退出 6/6。
- **首句截头仍在**（…9370「一下」、…9435「你去测试一下」，VAD 起点 +145/+253 ms）：worker 侧已无可压空间，坐实主因在**设备发布麦克风轨 → worker 订阅到** 这 ~0.4–0.6 s 与端侧提示时机之间；开口晚 ~0.3 s 以上的（…9418 +286 ms）就完整。

### 4.2 川哥拍板方向（08:06）：唤醒后立刻并行建房并发轨，不等提示音；worker 侧屏蔽预置本地招呼语

按 worker 侧看到的时序，房间本身早就是并行的（job 在唤醒后 ~0.5–1 s 已接房、已发出声轨、已预组装完毕，之后一直在等设备的麦克风轨）；**串行的只有一段：设备等提示音播完才发布麦克风轨**，于是「发轨 → 订阅 → input_ready」这 ~0.4–0.6 s 全部暴露在提示音结束之后，而 v237 的「可以说了」提示又抢在它前面。

建议端侧改成（v236 的并行 + v237 的不回灌，两者兼得）：

1. **唤醒即发布麦克风轨**（与提示音并行），worker 在提示音期间就订到轨、开始听——input_ready 在提示音还没播完时就到端侧。
2. **提示音播放期间麦克风轨静音**（LiveKit `LocalAudioTrack.mute()`，或送静音帧；二选一，见下），提示音播完 +200 ms 尾音保护后 unmute——喇叭里的招呼语根本不进上行，回灌为零，不依赖任何过滤。
3. 「可以说了」提示 = **max(提示音播完+200ms, 已收到 input_ready)**——此时 worker 一定在听，首句不再截头；预期比现在早 ~0.4–0.6 s。
4. mute 与静音帧的区别：mute 后 SFU 不转发帧，worker 的 input_ready 要到 unmute 后首帧才发（提示音播完 +100–200 ms）；送静音帧则 input_ready 在提示音期间就发出，提示可以精确落在提示音播完那一刻。**推荐送静音帧**（或 unmute 时机提前到尾音保护开始）；两种 worker 都不用改。

worker 侧承诺（不改协议、不加信令）：
- 静音帧/mute 期间 VAD 不起跳、ASR 无输出，不会产生任何 turn；input_ready 语义不变（首帧 PCM 到达即发）。
- 若端侧选择**不静音、真拾音并行**（v236 形态），worker 现有两道门兜底：精确回声库（内置 9 条 + 该设备动态招呼语，LCS≥0.8/子串）+ v4 放宽门（第 1 句且无 VAD 起点 + LCS≥0.3）。诚实边界：喇叭近场、招呼语触发了 VAD 又被错转到 LCS<0.8 的那一类（v236 时期的幽灵句形态之一）worker 仍拦不住——所以**静音是根治，过滤只是兜底**，别反过来。
- worker 已无待办；本轮不再改。

验收（下一轮真人）：提示一出就说「说个长句测试一下」×3 → worker 3/3 完整且 VAD 起点 ≥ +200 ms；唤醒 → 可说话 比现在缩短 ≥0.4 s（端侧钟）；提示音期间 worker 零 VAD 起点、零 commit（静音生效的直接证据）。

状态：**WORKER_PREBUILD_VERIFIED(track→loop 2–13ms) / HEAD_CLIP_STILL_PRESENT(device-side) / PROPOSAL_publish_at_wake+mute_until_prompt_end+cue_on_input_ready / WORKER_NO_FURTHER_CHANGE**
