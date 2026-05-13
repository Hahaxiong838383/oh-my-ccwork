# K1 实时语音技术选型（4天交付）

## 一、端到端方案对比（5选）

| 方案 | 链路图 | 协议 | 流式(STT/LLM/TTS) | 国内可达性 | 预估延迟 | 难度 | 伪代码示意 | 坑点 |
|---|---|---|---|---|---|---|---|---|
| 1 豆包Realtime(RTC) | 前端→RTC→方舟实时对话→前端 | WebRTC/RTC | 是/是/是 | 直连 | 0.9~1.6s | ★★★★☆ | `joinRTC→pushAudio→onAudio/onState` | RTC鉴权与iOS音频策略复杂 |
| 2 MiniMax三段 | 前端→STT→M2.5→Speech→前端 | WS+HTTP | 待确认/是/是 | 直连 | 1.4~2.4s | ★★★☆☆ | `audioChunk→stt→llm.stream→ttsWs` | STT文档入口不清晰，先核验能力 |
| 3 WebSpeech+Gemini+MiniMaxTTS | WebSpeech→Gemini(4000)→TTS | 浏览器API+WS | 部分/是/是 | 需代理 | 1.2~2.8s | ★★☆☆☆ | `onresult→gemini→tts.stream` | Safari仅部分支持，稳定性波动 |
| 4 OpenAI Realtime(4001) | 前端→4001→Realtime→前端 | WebRTC/WS | 是/是/是 | 需代理 | 1.0~2.0s | ★★★☆☆ | `connect→sendAudio→recvDelta` | 4001是否透传WS/WebRTC未知 |
| 5 火山ASR+豆包LLM+火山TTS | 前端PCM→ASR→Chat→TTS v3→前端 | WS+流式HTTP | 是/是/是 | 直连 | 1.1~2.0s | ★★★☆☆ | `asr.send→chat.stream→tts.bidirection` | VAD断句与打断状态机要做细 |

## 二、最终推荐

- 首选：**方案5（火山ASR + 豆包LLM + 火山TTS）**
- 备选：**方案1（豆包Realtime RTC一体化）**

选择理由：
1. 4天内最可控：三段可分别压测与替换，故障定位快。  
2. 国内链路更稳：不依赖跨境主通路。  
3. `emotion/action`可在LLM层结构化输出，前端动画对接最直接。

## 三、MVP实施步骤（仅语音）

- D1 上午：麦克风采集、16k PCM分片、前后端WS、ASR回写。  
- D1 下午：接豆包Chat流式，跑通`text+emotion+action`。  
- D2 上午：接火山TTS v3流式，跑通增量播音。  
- D2 下午：做插话打断（停播/清队列/新turn重建）。  
- D3 调优：分片80~120ms、VAD阈值、弱网重连、iOS恢复。  
- D4 迁云端：同地域部署Node/Bun，补鉴权、限流、日志与压测。

## 四、关键风险与对策

1. 首包慢：LLM增量满N字即推TTS；监控`e2e_ms`。  
2. iOS不自动播放：首屏手势解锁AudioContext。  
3. 插话后重叠播音：`turnId+generation`，旧代音频丢弃。  
4. 代理抖动：主链路固定国内服务，Gemini/OpenAI仅灰度。  
5. 权限开通卡住：D1设止损，立即切备选方案1。

## 五、WebSocket接口契约草案

```text
C->S session.start {sessionId,userId,sampleRate:16000,format:"pcm16"}
C->S audio.chunk   {sessionId,seq,ts,data_base64}
C->S user.interrupt{sessionId,reason:"barge_in"}

S->C asr.partial   {sessionId,seq,text,isFinal:false}
S->C asr.final     {sessionId,seq,text,isFinal:true}
S->C npc.reply.delta{sessionId,turnId,textDelta,emotion,action}
S->C tts.audio.chunk{sessionId,turnId,audio_base64,codec,isFinal:false}
S->C tts.audio.end {sessionId,turnId,isFinal:true}
S->C turn.done     {sessionId,turnId,latency:{asr_ms,llm_ms,tts_ms,e2e_ms}}
S->C error         {sessionId,code,message,retriable}
```

## Summary
首选“火山ASR+豆包LLM+火山TTS”三段拆解，因为4天内最稳、最可控、最易排障。备选“豆包Realtime RTC一体化”，时延潜力更高但接入复杂。先在D2跑通可演示链路，D3集中优化延迟和打断体验。
