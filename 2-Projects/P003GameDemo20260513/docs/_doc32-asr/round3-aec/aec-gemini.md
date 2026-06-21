# 小可端侧 ASR「TTS 自声触发自唤醒」评审及解决方案设计报告

## 一、Demo 阶段方案对比与推荐度排序

综合评估防自唤醒效果、工程量、语音打断（Barge-in）体验及低端机运行负载，方案推荐度排序如下：

### Rank 1：方案 A' —— 文本感知动态 Gating 方案 (强烈推荐)
*   **原理**：Web 端在下发 TTS 文本段落时，判断该句是否包含“小可”字样。若不含，KWS 保持运行（微调阈值）；若包含，在该句播放期间彻底 Gating 暂停 KWS。
*   **推荐理由**：
    1.  **极高性价比**：在陪伴场景中，TTS 提到“小可”的句子占比通常低于 15%。这意味 **85% 以上的时间里语音打断（Barge-in）依然可用**。
    2.  **100% 解决自唤醒**：在最易触发自唤醒的“自我介绍/带关键词台词”播放时，KWS 被彻底屏蔽，自唤醒率为 0。
    3.  **零 DSP 负载**：无任何额外 CPU 消耗，低端机非常友好。

### Rank 2：方案 A —— 全局无条件 Gating + 延迟恢复 + 屏幕触控兜底 (次选兜底)
*   **原理**：TTS 播放期间无条件暂停 KWS 喂帧，TTS 结束后延迟 300ms 恢复。
*   **推荐理由**：实现极其简单（1小时内），100% 避免自唤醒。缺点是彻底失去了语音打断能力，必须依赖触控打断作为体验兜底。

### Rank 3：方案 D —— 启发式动态阈值调整 (不推荐)
*   **原理**：TTS 期间将 KWS 阈值由 0.2 临时提高至 0.6。
*   **不推荐理由**：难以调优。扬声器近场声音大，0.6 仍可能被自唤醒；同时儿童声线弱，在此门限下几乎无法实现语音打断，容易造成双输。

### Rank 4：方案 C —— 通话模式 + 硬件 AEC (直接否决)
*   **不推荐理由**：迫使 Android 切换到通话声道，会严重损伤 TTS 音质，且音频极易路由至听筒，完全背离儿童陪伴产品的保真音质与外放需求。

---

## 二、最优解方案（Rank 1 / Rank 2）实现要点

### 1. 核心状态同步与延迟控制 (解决恢复期余振自唤醒)
*   **延迟参数取值**：TTS 播放结束到 KWS 恢复的延迟时间建议设为 **300ms**。
    *   **原因**：Android WebView 的 `STREAM_MUSIC` 存在音频输出缓冲区延迟（通常 100ms - 200ms）。当 Web 端触发 `onPlaybackEnd` 时，硬件扬声器仍在播放尾音，加之房间物理声学混响（Reverb），若立即恢复 KWS 会导致尾音自唤醒。300ms 延迟可安全覆盖此振幅衰减期。
*   **AudioEngine 代码层修改位置**：
    *   **状态维护**：在 `AudioEngine` 中定义 `private var isKwsGated = false`，并通过 `Handler` 或 `Coroutine` 控制延迟复位。
    ```kotlin
    private val kwsResetHandler = Handler(Looper.getMainLooper())
    private val resetKwsRunnable = Runnable { isKwsGated = false }

    fun notifyTtsState(speaking: Boolean, containsKeyword: Boolean) {
        kwsResetHandler.removeCallbacks(resetKwsRunnable)
        if (speaking) {
            // 如果本句包含唤醒词，或者为全局 Gating 模式
            if (containsKeyword || GLOBAL_GATE_MODE) {
                isKwsGated = true
            } else {
                isKwsGated = false
                // 在此期间微调 KWS 阈值至 0.35 防止一般性回声
                keywordSpotter.setThreshold(0.35f)
            }
        } else {
            // TTS 结束，延迟 300ms 恢复 KWS
            kwsResetHandler.postDelayed(resetKwsRunnable, 300)
            keywordSpotter.setThreshold(0.20f) // 恢复正常童声阈值
        }
    }
    ```
    *   **录音帧分流控制**：在 `AudioRecord` 的循环读取线程中过滤喂给 `KeywordSpotter` 的数据：
    ```kotlin
    val buffer = ShortArray(frameSize)
    while (isRecording) {
        val readSize = audioRecord.read(buffer, 0, frameSize)
        if (readSize > 0) {
            // ASR 物理丢帧逻辑保持不变（如果是 TTS 期间）
            if (!isTtsSpeaking) {
                asrEngine.feed(buffer)
            }
            // KWS 喂帧控制
            if (!isKwsGated) {
                keywordSpotter.feed(buffer)
            }
        }
    }
    ```

### 2. Barge-in 交互兜底方案
*   **全屏触控打断（Tap-to-Interrupt）**：
    在 WebView TTS 播放期间，APP 界面往往有动画。将整个屏幕或角色交互区域设为打断热区。只要检测到任何 Touch 事件：
    1. 立即调用 JS 接口停止 WebView TTS 播放；
    2. 主动触发 `notifyTtsState(speaking = false)` 并清除 300ms 延迟，直接将 `isKwsGated` 置为 `false` 并启动 ASR 听音。
    该设计对于儿童来说非常直观（“拍一下小可，它就闭嘴听我说话”）。

---

## 三、Demo 阶段的低成本“聪明”组合解法

如果选择 **方案 A' (文本感知动态 Gating)** + **轻量级阈值微调**，可以实现兼顾打断与不自唤醒的最佳体验：

1.  **分段 TTS 与文本过滤**：
    Web 端下发 TTS 时，按标点符号断句（例如：“你好呀，我是小可。[句1] 今天我们去哪里玩呢？[句2]”）。
    *   **句1** 包含“小可”：调用 `notifyTtsState(true, containsKeyword = true)` → **KWS 彻底暂停**。
    *   **句2** 不含“小可”：调用 `notifyTtsState(true, containsKeyword = false)` → **KWS 继续跑，但临时将阈值从 0.20 提升到 0.35**。
2.  **阈值微调的作用**：
    0.35 阈值能够有效滤除由于手机外放产生的结构共振和中低音回声，避免非关键词句子的自唤醒；同时，0.35 门限对于距离手机 30-50cm 的儿童大声说话打断，依然保留了较高的唤醒概率。

---

## 四、长期（非 Demo）演进正解

Demo 阶段结束后，要实现高保真（STREAM_MUSIC）且完美的实时语音打断，必须走**原生音频渲染 + 软件回声消除（AEC）**路线：

1.  **链路收拢**：将 TTS 的播放权从 WebView 收回到 Android 原生端，通过 `AudioTrack` 写入播放。
2.  **获取参考信号（Reference Signal）**：
    软件 AEC（如 WebRTC AEC3 或 SpeexDSP）需要两路输入：
    *   **Mic 信号**：来自 `AudioRecord`。
    *   **Ref 信号**：即将写入 `AudioTrack` 播放的 TTS 原始 PCM 数据。
3.  **对齐与消噪**：
    在原生层将 Ref 信号与 Mic 信号进行时间戳对齐，送入软件 AEC 引擎消噪，将消噪后的 Mic 数据送入 KWS 和 ASR。
    这样可以确保无论 TTS 播放什么内容（即使一直说“小可小可”），KWS 也完全不会误触发，且儿童可以在任意时刻以正常音量语音打断。

---

## 五、Demo 阶段一句话结论

> **“采用文本感知动态 Gating 方案：TTS 句中含‘小可’则彻底停 KWS，不含则 KWS 降敏运行，TTS 停播后延时 300ms 恢复，并提供全屏触控作为打断兜底。”**

***

署名：gemini（Google）
