# jarvis-server — 贾维斯语音后端

> 目标：Grok 级丝滑语音交互。全链路流式，<2 秒响应，随时打断随时说。

## 架构

```
ESP32 BOX1 (小智AI固件)
    ↓ WebSocket (Opus 音频流)
jarvis-server (Python, 本NAS)
    ├── 流式 ASR (FunASR / Whisper) → 边说边识别
    ├── 流式 LLM (Gemini function_call) → 边识别边推理
    ├── 流式 TTS (Edge-TTS) → 边推理边合成
    ├── HA 控制 (直接 HTTP 调用)
    └── xiaomusic 控制 (HTTP 调用)
    ↓ WebSocket (Opus 音频流)
ESP32 BOX1 播放
```

## 核心设计原则

1. **全流式**：ASR/LLM/TTS 三段 pipeline 流式串联，不等任何环节完成
2. **随时打断**：检测到用户开始说话，立即停止当前 TTS 输出
3. **一次调用**：Gemini function_call 一步完成意图+回复，不做前置意图分类
4. **零本地算力**：所有推理走云端 API（Gemini），本地只做音频编解码

## 对比小智后端

| 特性 | 小智后端 | jarvis-server |
|------|---------|--------------|
| ASR | 离线批处理 | 流式（边说边出） |
| LLM | 2次调用（意图+回复） | 1次（function_call） |
| TTS | 等 LLM 完再生成 | 流式（LLM 出第一句就播） |
| 打断 | 唤醒词打断 | VAD 打断（人声就停） |
| 响应延迟 | 5-8秒 | 目标 <2秒 |
| 协议 | 兼容小智 WebSocket | 兼容小智 WebSocket |

## 文件结构

```
jarvis-server/
├── server.py          # WebSocket 服务 + 主循环
├── asr.py             # 流式 ASR（FunASR 本地）
├── llm.py             # Gemini function_call（流式）
├── tts.py             # Edge-TTS 流式合成
├── ha.py              # Home Assistant 控制
├── music.py           # xiaomusic 控制
├── config.py          # 配置（设备列表、API key 等）
└── requirements.txt
```
