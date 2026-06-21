【阻塞性】单一 `libsherpa-onnx-jni.so` 同时支撑 KeywordSpotter + OnlineRecognizer 的可行性未验证。
【为什么是问题】方案仅标注“推断(高)”，但 Android AudioRecord 句柄互斥 + JNI 流实例共享在切换时刻极易出现资源竞争或 decode 崩溃；若无法并存，则唤醒→ASR 无缝衔接彻底失效。
【建议修法】P0 必须在真机上实例化两个流对象并测试 KWS 命中后切 ASR 的全链路；失败则强制实现单一 AudioEngine 统一管理 AudioRecord。

【阻塞性】`chat.trigger` 复用时 captureMode='feedback' 携带机制缺失。
【为什么是问题】现状 server 反馈库依赖 session/audio 路径落孩子真实语音；端侧 final 走 trigger 后若不带 captureMode，吐槽采集链路直接断裂，影响后续数据。
【建议修法】P1 前必须确认 server 是否支持 trigger 带 metadata，或新增 asr.text 消息类型；否则反馈库功能丢失。

【阻塞性】麦克风从 Web getUserMedia 翻转给原生持有的时序安全未论证。
【为什么是问题】WebView 释放与原生 AudioRecord acquire 之间存在窗口，Android 音频会话可能被系统/其他 App 抢占，导致切换 gap、权限丢失或双持麦崩溃。
【建议修法】强制采用单一 AudioEngine 持有 AudioRecord，KWS/ASR 只切换流对象；bridge 协议增加 acquire/release 同步确认。

【阻塞性】TTS 播放期物理静音 ASR 但保留 KWS 打断的 AudioRecord 状态冲突。
【为什么是问题】同一 AudioRecord 在 speaking 期需同时支持 KWS 继续解码与 ASR 暂停输入；物理丢帧实现若不区分两路，KWS 可能因无输入失效或自声误触发。
【建议修法】明确 speaking 期 KWS 是否也挂起，或增强 AcousticEchoCanceler；AEC 联调必须覆盖 KWS 打断场景。

【阻塞性】Android 音频会话（AudioRecord source + 通话模式）与 WebView TTS 输出路由冲突未覆盖。
【为什么是问题】TTS 在 WebView 播时原生 ASR 持麦，AudioRecord VOICE_RECOGNITION 可能与系统音频路由冲突，导致 mic 不可用或 TTS 走错误输出设备。
【建议修法】AsrBridge 必须显式管理 AudioManager.setMode + 路由；真机测试必须包含 TTS 播放期 ASR 状态。

【优化项】童声 endpointing 起点取 1.2–1.5s 的方向正确，但未给出真机调参 checklist。
【为什么是问题】docs/31 的 0.3s 确实太激进，方案已正确拒绝；但 rule2 具体值仍需 5–10 岁样本实测，否则多轮 followup 截断率不可控。
【建议修法】P3 增加 endpoint 延迟/截断率/童声拖音场景的量化指标。

【优化项】端侧 partial 高频喂字幕未做节流。
【为什么是问题】Zipformer 流式输出可能 50–100ms 一帧，直接 setSubtitle 会造成 WebView UI jank，尤其中端机。
【建议修法】bridge 侧加 150–200ms 节流或 diff 后才回调。

【优化项】模型 assets 打进 APK 的真实体积膨胀未量化。
【为什么是问题】type 9/20 的 encoder+decoder+joiner+tokens 落盘体积远超“14M 参数”估算，直接影响安装包大小与下载。
【建议修法】P0 实测 assets 体积并记录在交付清单。

一句话总评：这方案不能直接进 P1，必须先解决前五条阻塞性问题（单一 .so 验证、captureMode 携带、麦克风翻转竞态、AEC/KWS 冲突、音频会话路由）才能开干。

署名：grok（xAI）
