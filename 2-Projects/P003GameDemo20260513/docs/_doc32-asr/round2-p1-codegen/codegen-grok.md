**P1 任务完成**：`AudioEngine + AsrBridge` 原生核心已实现（仅改动 android-shell Kotlin 层，web/server 零改动）。

### 产出文件
- `app/src/main/java/cc/hahaxiong/kidshub/AudioEngine.kt`（新建，核心）
- `app/src/main/java/cc/hahaxiong/kidshub/AsrBridge.kt`（新建，JS 门面）
- `app/src/main/java/cc/hahaxiong/kidshub/WakeWordBridge.kt`（重构为纯委托）
- `app/src/main/java/cc/hahaxiong/kidshub/MainActivity.kt`（注入 + 生命周期更新）

### 编译验证
`JAVA_HOME=/opt/homebrew/opt/openjdk@17 ./gradlew assembleDebug` → **BUILD SUCCESSFUL**（多次 clean/assemble 均通过）。

### AC 逐条确认
- 单一 `AudioRecord`（仅 `AudioEngine` 内 `VOICE_RECOGNITION` 创建；WakeWordBridge 已无任何 `new AudioRecord`/`AudioRecord(` 实例，grep 全工程确认）。
- 状态机 + KWS↔ASR 无缝切换（不释放 AudioRecord）。
- ring buffer ~800ms pre-roll + KWS 命中回灌。
- TTS 物理丢帧 + KWS 继续 + 250ms 恢复。
- endpoint（`enableEndpoint=true` + rule2 1.1s 童声宽容）+ partial 节流（≥120ms 且文本变化）。
- 两种模式（ptt/auto）。
- 优雅降级（init 失败 → `isOnDeviceAsrAvailable()` 永久 false）。
- 麦克风互斥契约（`pause/startWakeListening`）保留。
- Bridge 协议（`KidshubNative` 保留旧方法 + 新增 4 个；`KidshubWeb` 新增 3 个回调）。

### 关键设计说明

**1. 状态机（EngineState）**
```kotlin
private enum class EngineState { IDLE, ASR, TTS_PLAYING }
@Volatile private var engineState: EngineState = ...
@Volatile private var asrMode: String = "auto"
@Volatile private var ttsSpeaking = false
```
- IDLE：仅跑 KWS stream。
- ASR：同时跑 KWS（打断）+ ASR feed。
- TTS_PLAYING：ASR 物理不喂（见下），KWS 持续。
- `startAsr` / KWS 命中 / `stopAsr` / `notifyTtsState` 驱动切换，全部 `@Volatile` + 线程内判断。

**2. Ring Buffer（~800ms pre-roll）**
内部 `AudioRingBuffer`（容量 12800 samples，circular FloatArray + `writePos`/`filled`，`@Synchronized` 的 `push` + `snapshot`）。
- 录音线程**每帧必** `ringBuffer.push(samples)`（与 KWS/ASR 解耦）。
- KWS 命中或 `startAsr` 时：`val hist = ringBuffer.snapshot(); newAsrStream.acceptWaveform(hist, 16000)`，再接后续实时帧 → 回溯启动，首字不丢。

**3. Partial 节流实现**
```kotlin
private const val PARTIAL_MIN_INTERVAL_MS = 120L
private var lastPartialText = ""
private var lastPartialTs = 0L

private fun maybeNotifyPartial(...) {
    val text = rec.getResult(stream).text.trim()
    val now = System.currentTimeMillis()
    if (text != lastPartialText && now - lastPartialTs >= PARTIAL_MIN_INTERVAL_MS) {
        ... notifyAsrPartial ...
        lastPartialText = text; lastPartialTs = now
    }
}
```
- `onAsrFinal` / `onAsrEndpoint` 立即、无节流。
- 仅在 ASR feed 路径调用。

**4. TTS gating 时序（致命自激防护）**
```kotlin
fun notifyTtsState(speaking: Boolean) {
    ttsSpeaking = speaking
    if (speaking) {
        ttsResumeTimestamp = 0
        if (state == ASR) state = TTS_PLAYING
    } else {
        ttsResumeTimestamp = now + 250
        if (state == TTS_PLAYING) state = ASR
    }
}

// 录音线程内
val ttsDrop = ttsSpeaking || now < ttsResumeTimestamp
if (!ttsDrop && ...) {
    asrStream.acceptWaveform(...)
    ... decode + partial + endpoint
}
// KWS 始终 accept + decode（不管 TTS）
```
- `true`：ASR 物理丢帧（不调用 accept），KWS 继续 → “小可小可”可打断。
- `false`：延迟 250ms 再喂（吸收 JS→Native 异步 50-120ms + 功放余振）。
- 明确不依赖 `AcousticEchoCanceler` 对 `STREAM_MUSIC` 生效。

**5. 其他关键点**
- 单一录音线程 + `isRecordingActive` 标志 + `join(900)` 退出。
- KWS/ASR stream 各自独立创建/reset/release，AudioRecord 生命周期完全由 engine 控制。
- `startAsr("ptt")` → `asrMode="ptt"`（忽略 `isEndpoint`）；`"auto"` 正常用。
- endpoint 配置：`rule2 = EndpointRule(true, 1.1f, 0f)`（童声宽容，非 0.3s 激进值）。
- 所有 try-catch Throwable + 置 null，init 失败不崩。
- 回调全部 `webView.post { evaluateJavascript(...) }`，文本简单 escape。

### 线程/资源契约
- 录音永远单线程。
- `pauseWakeListening` / `startWakeListening` 仍控制整条录音线程启停（Web 走云端 fallback 时仍有效）。
- `onResume/onPause/onDestroy` 全部下沉到 engine。

所有硬约束（team 四发评审收敛）均已逐条编码体现。P2 时 Web 侧（bridge.ts + 状态机）可直接调用新增接口，自动优雅回退。

**署名：codex（OpenAI Codex）| 完成时间**
