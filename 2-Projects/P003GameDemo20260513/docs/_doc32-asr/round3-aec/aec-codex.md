## 只读评审 finding：demo 阶段推荐结论

**demo 阶段一句话结论：推荐选「A + E」——TTS 播放期间硬 gate KWS，TTS 结束后再延迟约 500ms 恢复；同时保留 PTT/点击打断作为兜底，可选加一个非常保守的 mic 能量突增 barge-in。**  
理由：这是当前约束下唯一能稳定解决 P1 自唤醒、工程量小、低端机可跑、风险可控的方案。完整语音 barge-in 先不要用启发式硬撑，长期应走原生 TTS/render reference + 软件 AEC。

---

# 推荐度排序

## 1. 首选：A + E，TTS 期 hard gate KWS + post-roll 延迟恢复 + PTT/能量门兜底

### 结论

这是 demo 阶段最优解。

- **防自唤醒效果**：最好。TTS 期间不喂 KWS、不接受 KWS 命中，理论上直接切断「小可自己说小可 → KWS 命中」链路。
- **barge-in 保留情况**：会牺牲「TTS 播放时喊唤醒词打断」这一条路径，但可以用：
  - PTT/点击头像/按钮立即打断；
  - 可选的 mic 能量突增自动打断；
  - TTS 结束后很快恢复 KWS。
- **工程量**：小。已有 `notifyTtsState(speaking: Boolean)`，ASR 已经用它做丢帧，KWS 复用同一状态即可。
- **低端机负担**：几乎没有额外负担。
- **风险**：主要是 TTS 期间语音唤醒不可用，需要产品上接受这是 demo 阶段临时保护策略，并在 UI 上给打断入口。

### AudioEngine 实现要点

建议在 `AudioEngine` 里把 TTS 状态统一成 KWS 的硬阻断条件。

核心逻辑：

1. `notifyTtsState(true)` 时：
   - 设置 `ttsSpeaking = true`；
   - 设置 `kwsBlocked = true` 或 `kwsBlockedUntilMs = Long.MAX_VALUE`；
   - **立即 reset / recreate KWS stream**，清掉 TTS 开始前后的上下文；
   - 清空 pending KWS detection，避免异步晚到的命中被接受；
   - ASR 继续沿用已有 TTS 丢帧逻辑。

2. `notifyTtsState(false)` 时：
   - 设置 `ttsSpeaking = false`；
   - 不要立即恢复 KWS；
   - 设置 `kwsBlockedUntilMs = now + KWS_TTS_TAIL_SUPPRESS_MS`；
   - 再次 reset / recreate KWS stream，避免 TTS 尾音残留在 KWS 状态里。

3. AudioRecord 录音循环里：
   - 保持 AudioRecord 持续 read，不要停录音硬件；
   - 每帧音频进来后，先判断：
     - `ttsSpeaking == true`，或
     - `SystemClock.elapsedRealtime() < kwsBlockedUntilMs`
   - 若满足，**不要调用 KWS 的 acceptWaveform / decode / search**；
   - 即使某处仍然产生 KWS result，也要在「接受命中」前再检查一次 gate 状态，命中处于 TTS gate 窗口内就丢弃并 reset。

4. 线程安全：
   - WebView/JS 回调通常在主线程；
   - AudioRecord/KWS 在录音线程；
   - `ttsSpeaking`、`kwsBlockedUntilMs` 用 `AtomicBoolean` / `AtomicLong` 或 volatile 保证跨线程可见；
   - 时间用 `SystemClock.elapsedRealtime()`，不要用 wall clock。

5. 日志与可观测：
   - 打点：
     - TTS gate start/end；
     - KWS blocked duration；
     - blocked 期间丢弃的 KWS hit；
     - post-roll 内丢弃的 KWS hit；
     - PTT/能量门打断次数。
   - 这些日志对后续调 `post-roll` 很关键。

---

# 2. TTS 结束后 KWS 延迟恢复建议

## 推荐值

**默认取 500ms。**

建议做成常量或远程配置：

```text
KWS_TTS_TAIL_SUPPRESS_MS = 500ms
可调范围：300ms - 800ms
```

### 理由

TTS `onPlaybackEnd` / WebView 播放结束并不等于麦克风侧马上没有声音，仍然可能存在：

- Android 音频输出 buffer drain；
- 手机扬声器尾音；
- 桌面/房间近场反射；
- KWS 模型自身的滑窗检测滞后；
- 「小可」尾部音素残留。

300ms 在很多手机上可能够，但对 demo 的 P1 自唤醒修复来说，**500ms 更稳**。如果真机仍看到尾音触发，可以提到 **700ms**。不建议一上来超过 1s，否则孩子刚等小可说完马上喊「小可小可」会明显被吞。

## PTT/手动打断兜底

TTS 期间最不伤体验的兜底是：

1. 播放中 UI 明确显示：
   - 「点一下打断小可」
   - 或「按住说话」
   - 或头像/麦克风按钮处于可点击状态。

2. 用户点击/按住时：
   - WebView 立即停止 TTS 播放；
   - 调 `notifyTtsState(false)`；
   - KWS 仍按 500ms post-roll 继续屏蔽；
   - 但可以进入 **manual listening / PTT ASR 模式**，不依赖 KWS；
   - 为避免 TTS 尾音污染 ASR，建议 PTT 停播后给 ASR 一个更短的 tail guard，例如 **150ms - 300ms**，再开始喂 ASR。

3. UI 上最好给一个轻反馈：
   - TTS 立即停；
   - 按钮变成「我在听」；
   - 引导孩子停顿一下再说。

这样虽然牺牲了「喊唤醒词打断」，但保留了「孩子可以打断小可」这个体验目标。

---

# 3. 比 A-D 更低成本的聪明组合

## 3.1 推荐作为增强：TTS 期粗粒度能量门 barge-in

在 TTS gate KWS 的基础上，可以增加一个不依赖唤醒词的轻量 barge-in：

**TTS 期间 KWS 不跑，但 AudioEngine 仍计算 mic 能量。**  
如果检测到远高于当前 TTS 漏音基线的持续能量突增，则认为孩子在说话，触发打断 TTS。

### 实现方式

在 AudioEngine 录音循环中，每 10ms/20ms 计算一次 RMS 或 dBFS：

- 维护 TTS 期 mic 能量的慢速 EMA 作为 `ttsLeakBaselineDb`；
- 检测短时能量 `currentDb`；
- 触发条件建议保守一些，例如：
  - `currentDb > ttsLeakBaselineDb + 10~15dB`；
  - 持续 `200ms - 300ms`；
  - TTS 开始后的前 `300ms` 不触发，避开播放器起播瞬态；
  - 触发后设置 cooldown，避免连续误触发。

触发后：

1. 通知 Web 停止 TTS；
2. `notifyTtsState(false)`；
3. 进入 manual ASR listening；
4. KWS 仍按 post-roll 恢复。

### 风险

这个方案没有 TTS PCM reference，所以只能是启发式：

- TTS 自身的大音量峰值也可能被误判成人声；
- 手机外放音量、壳体、环境噪声差异很大；
- 不应把它当作 P1 修复主方案。

建议作为 **可关闭的实验开关**。默认阈值要保守，宁愿少触发，也不要让小可频繁自己打断自己。

---

## 3.2 推荐作为补丁：TTS 文案避免读出唤醒词

低成本内容侧保护：

- 小可 TTS 尽量少说「小可小可」；
- 不要复读用户的唤醒词；
- 自我介绍里可将部分「小可」改成「我」；
- 对模型特别敏感的固定话术做 TTS 文案审查。

这不能替代 KWS gate，因为 TTS 还是可能说到「小可」，而且阈值 0.2 下单个「小可」也可能触发。但它能降低漏网风险。

---

## 3.3 不推荐作为主修复：TTS 期提高 KWS 阈值 / 二次确认

也就是候选 D。

问题是：

- 当前 TTS 声音是清晰、稳定、近场扬声器播放，反而可能比儿童远场喊话更像模型训练分布；
- 阈值提高不一定挡得住自声，却一定会伤害童声召回；
- 「TTS 文本即将说到小可时屏蔽」需要可靠字级/音素级时间戳，WebView TTS 当前通常拿不到；
- 命中后等 300ms 看持续人声，TTS 本身也是持续人声，不能稳定区分。

所以 D 可以作为后续实验，不适合作为 P1 demo 修复主路径。

---

# 4. 其他候选方案评估

## B. TTS + 播放搬原生 + 软件 AEC

### 结论

**长期正解方向，不适合 demo 立刻做。**

优点：

- 可以保留真正的 full-duplex barge-in；
- 原生侧同时拿到：
  - render/reference PCM；
  - mic PCM；
- 可以用 WebRTC AEC3 / SpeexDSP AEC 做回声消除，再把 echo-cancelled mic 喂给 KWS/ASR。

缺点：

- 要改 TTS 链路、播放链路、Web/native 协议；
- 需要处理采样率、延迟估计、buffer 对齐、设备差异；
- 低端机 CPU 压力和调参成本不可忽略；
- AEC 做不好会出现残余回声、双讲损伤、ASR/KWS 召回下降。

适合放入长期技术方案，不建议作为 demo P1 hotfix。

---

## C. MODE_IN_COMMUNICATION + VOICE_CALL 硬件 AEC

### 结论

**不推荐。**

已知问题已经验证：

- 会破坏 TTS 音色；
- 可能路由到听筒；
- 采样率/音频链路受限；
- 和儿童陪伴 App 的外放体验冲突。

除非未来做设备白名单、明确某些机型效果可接受，否则不应作为通用方案。

---

# 5. 长期非 demo 正解

长期建议做完整 full-duplex 音频架构：

1. **TTS/render 搬到原生或至少让原生拿到播放 PCM reference**
   - WebView 只负责文本、状态和 UI；
   - 原生负责 TTS 合成/解码/AudioTrack 播放；
   - 原生保存 render-side PCM 给 AEC。

2. **接入 WebRTC AEC3**
   - render stream 和 capture stream 统一时钟；
   - 10ms frame 处理；
   - 做采样率转换和 delay alignment；
   - echo-cancelled mic 再喂 KWS/ASR。

3. **barge-in 独立建模**
   - 不一定完全依赖唤醒词；
   - 可以用 VAD + KWS + AEC 后置信度融合；
   - TTS 期间检测到孩子说话时先 duck/stop TTS，再进入 ASR。

4. **模型和数据层增强**
   - 收集小可 TTS 从手机扬声器外放后被麦克风录到的数据，作为 KWS negative；
   - 增加不同音量、不同机型、不同距离、儿童声场景；
   - 调整 KWS 阈值不要长期卡在 0.2 的高风险状态；
   - 做机型维度评估。

5. **不要依赖通话模式作为通用解法**
   - 可做机型白名单实验；
   - 但不要把 MODE_IN_COMMUNICATION 当主路径。

---

# 最终建议

demo 阶段直接落地：

```text
TTS speaking == true:
    KWS 不喂帧、不接受命中、reset KWS state
TTS ended:
    延迟 500ms 后恢复 KWS
TTS 期间打断:
    PTT/点击打断为主
    可选保守能量门自动打断
长期:
    原生 TTS/render PCM + WebRTC AEC3 + full-duplex barge-in
```

这是当前在「必须修自唤醒、不能上重型 DSP、WebView TTS 仍走 STREAM_MUSIC、低端机可跑」约束下的最稳方案。

署名：codex（OpenAI）
