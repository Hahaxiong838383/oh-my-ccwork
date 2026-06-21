## 阻塞性 Findings

1. 【问题】`chat.trigger` 不能“原样复用”承载端侧 ASR final  
【为什么是问题】`chat.trigger` 语义更像文本触发/开场白，直接复用会混淆“真实儿童语音”“系统触发”“手输文本”，反馈库 `captureMode='feedback'`、ASR 日志、风控、埋点、回放排障、限额统计都可能丢语义。  
【建议修法】新增或扩展协议为 `asr.text` / `chat.trigger(source='on_device_asr')`，必须带 `text、captureMode、utteranceId、source、mode(auto/ptt)、timestamps、isFinal=true`；server 内部仍可复用现有 LLM→TTS pipeline，但入口语义要显式区分。

2. 【问题】KWS→ASR 只说“同一 AudioRecord 切流”还不够，缺少 pre-roll / ring buffer 设计  
【为什么是问题】KWS 命中通常发生在唤醒词结束后，孩子可能马上接正文；如果命中后才创建 ASR stream 或 reset 状态，首字/前 300–800ms 极易被吞。释放重开 `AudioRecord` 更会引入 HAL warmup、权限焦点、线程调度 gap。  
【建议修法】P1 必须采用单一 `AudioEngine + 单 AudioRecord`，维护 1–2 秒 PCM ring buffer；KWS 命中后把“命中后尾部 + 最近上下文帧”灌给 ASR，再进入 ASR 态。不要双开 recorder，不建议释放重开。

3. 【问题】AEC 方案“WebView 播 TTS → JS 通知原生静音 ASR”时序不可靠  
【为什么是问题】WebView media 事件、音频真正出声、蓝牙/外放路由、系统 ducking、缓冲播放之间有延迟；`onPlaybackEnd` 也不等于扬声器物理声已衰减。只靠 JS 边界会导致 TTS 头尾被 ASR 收进去，或者恢复 ASR 时吞用户抢答首字。  
【建议修法】加原生侧状态机和保护窗：`speaking=true` 前先停 ASR feed，播放结束后延迟 150–300ms 再恢复；barge-in 时先 cancel/duck TTS，确认输出停止后再开 ASR。更优方案是中期把 TTS 播放也收敛到原生，至少让原生持有权威 playback lifecycle。

4. 【问题】“speaking 期保留 KWS、静音 ASR”会产生打断竞态  
【为什么是问题】同一 PCM 在 TTS 期要继续喂 KWS，但不能喂 ASR；一旦 KWS 命中，需要同时取消 WebView TTS、切 ASR、清理旧 ASR stream、避免把小可尾音当孩子输入。这里不是简单 `notifyTtsState(false)`。  
【建议修法】定义明确事件序列：`KWS_HIT_DURING_TTS → web.cancelTts/ttsStoppedAck → drain guard → startAsr(with pre-roll policy)`；ASR stream 在 speaking 期应 reset 或隔离，不能累积静音期前后的脏上下文。

5. 【问题】模型 type 9 vs type 20 不能只按“先小后大”拍板，必须先验 ABI/资产/内存/实时率  
【为什么是问题】`type 20` 的 tokens、模型文件名、配置字段可能和 Kotlin 注册表/当前 JNI 版本不完全匹配；`type 9` 虽快但童声 CER 可能直接影响意图命中。中端机更关键的是 RTF、峰值 RSS、温升，而不是标称参数量。  
【建议修法】打通起点建议仍用 `type 9`，但 P0 交付门必须同时跑 `type 9/type 20` smoke：模型能加载、首 token 延迟、RTF、RSS、APK 增量、10 条儿童样本 CER。若 `type 9` 意图命中明显差，不能进入 P1 盲写。

6. 【问题】判停只给 `rule2=1.2–1.5s` 起点是合理但不完整  
【为什么是问题】童声慢、犹豫、拖音多，0.3s 确实太激进；但 1.5s 会增加交互尾延迟，且 Zipformer partial 可能有回改，`onAsrEndpoint` 和 `onAsrFinal` 顺序若处理不好会提前 finishTurn。  
【建议修法】起点认可 `rule2=1.2–1.5s`，建议从 `1.2s` 起测，按截断率上调；`rule1` 保持默认或略放宽，`rule3=20s` 需覆盖孩子长句/讲故事场景；web 必须等 final 文本稳定后再入 LLM，`endpoint` 只作为停止录音信号。

7. 【问题】“单一 `libsherpa-onnx-jni.so` 同时跑 KWS 和 OnlineRecognizer”是高概率成立，但不能作为实现前提跳过首验  
【为什么是问题】官方惯例不等于当前打包的 `.so` 包含所有符号和依赖；KWS 与 ASR 同进程并存还涉及 ORT session 内存、线程池、初始化顺序、重复加载 tokens/assets。  
【建议修法】P0 必须写成硬门槛：同一进程先后初始化 `KeywordSpotter` 与 `OnlineRecognizer`、并发持有但单路 PCM 切换、连续 15 分钟无 crash/OOM；失败则升级 sherpa-onnx 包或拆加载策略。

## 优化项 Findings

8. 【问题】端侧 partial 高频直推 Web 字幕会压垮 JS/UI  
【为什么是问题】Zipformer decode loop 可能几十毫秒更新一次，WebView bridge 高频调用会造成主线程抖动、字幕闪烁、耗电。  
【建议修法】原生或 web 做节流：例如 100–200ms、文本变化才推、同一 `utteranceId` 去重；final 不节流。

9. 【问题】APK 体积与模型资产分发策略未定  
【为什么是问题】Zipformer encoder/decoder/joiner/tokens 打进 APK 会显著膨胀安装包，影响下载转化；多 ABI 或未来 type 20 更明显。  
【建议修法】P0 同步量化 APK 增量；若超阈值，考虑 Play Asset Delivery / 首启 Wi-Fi 下载 / 仅 arm64 支持声明，并设计模型缺失回退云 ASR。

10. 【问题】Android 音频会话和路由策略缺少约束  
【为什么是问题】`VOICE_RECOGNITION`、AEC/NS、WebView 播放、蓝牙 SCO/耳机、外放切换可能互相影响；AEC 是否生效取决于 device/audio session，不能保证覆盖 WebView 输出。  
【建议修法】明确支持矩阵：首版优先外放/有线/普通蓝牙 A2DP，记录 route 变化；必要时禁用通话模式，避免乱设 `MODE_IN_COMMUNICATION`，并把异常 route 降级到云或关闭端侧 ASR。

11. 【问题】原生结构不应是 `AsrBridge` 独立抢麦  
【为什么是问题】独立 bridge 容易让 KWS、ASR、TTS 状态分散，后续 debug 竞态困难。  
【建议修法】`AsrBridge` 只做 JS API 门面，真正音频状态机放进 `AudioEngine`；`WakeWordBridge` 也应委托给同一个 engine。

12. 【问题】回退云火山路径要防止双 ASR 同时工作  
【为什么是问题】端侧初始化慢或失败时，web 可能已启动 getUserMedia；若原生也持麦，会出现权限争抢、重复 final、重复扣限额。  
【建议修法】启动时先协商 `asrProvider`，一个会话内只允许一个 active provider；provider 切换必须显式 stop/ack。

## 六个开放决策结论

- 模型起点：`type 9` 作为工程打通起点，但 P0 同时 smoke `type 20`，用真机 RTF/RSS/CER 决定是否升级。  
- 麦克风衔接：必须单 `AudioRecord + AudioEngine + ring buffer`，不建议释放重开。  
- 判停起点：认可否决 `0.3s`；建议 `rule2=1.2s` 起测，按截断率调到 `1.5s`。  
- server 协议：不要裸复用 `chat.trigger`；新增 `asr.text` 或扩展字段，保留内部 pipeline 复用。  
- 原生结构：`AsrBridge` 做薄桥，KWS/ASR/TTS gating 合入统一 `AudioEngine`。  
- 主要遗漏：pre-roll、TTS lifecycle ack、partial 节流、模型体积、音频 route、双 provider 互斥。

一句话总评：方案方向正确，但不能直接进 P1 写码；必须先补齐 `server ASR 语义协议`、`单 AudioEngine + pre-roll`、`TTS/AEC 状态机`、`P0 模型/JNI 真机首验` 这四条阻塞项。

署名：codex（OpenAI）
