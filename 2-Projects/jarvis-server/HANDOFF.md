# HANDOFF — 贾维斯语音系统跨 session 交接文档

> **新 session 接手时先读这个文件。**
> 最后更新：2026-03-31

---

## 项目目标

**O1**：实现 Grok 级丝滑语音交互——随时说话、随时打断、<2秒响应、自然对话

**O2**：
- 不绑定特定实现方案
- ESP32 固件可改
- 零本地大模型算力（NAS i5-8500 性能有限）
- 以 MiniMax M2.7 为主 API

---

## 当前架构全景

```
ESP32 BOX1（正点原子 DNESP32S3B）
  固件：小智AI v2.2.4 + 自定义唤醒词"贾维斯"（MultiNet5 中文）
  WiFi：NETGEAR，IP 192.168.1.50
  OTA：http://<NAS_IP>:8105/xiaozhi/ota（本地 OTA 服务）
  USB：Slave 口连 NAS（/dev/ttyACM0，刷固件用）
    ↓ WebSocket（Opus 音频）
NAS（飞牛 fnOS，i5-8500，16GB RAM）
  ├── jarvis-server v1（端口 8201）← 新后端，正在开发
  ├── xiaozhi-esp32-server（端口 8100）← 旧后端，可用但体验一般
  ├── Home Assistant（端口 8123，Docker）
  ├── xiaomusic（端口 58090，Docker）
  ├── Ollama + Qwen2.5-3B（端口 11434）
  ├── Whisper STT（Wyoming，端口 10300）
  ├── mycc 后端（端口 18080，记忆系统 v5.5）
  └── 本地 OTA 服务（端口 8105）
```

---

## 关键进展

### 已完成 ✅

1. **ESP32 固件**：小智AI v2.2.4 fork，自定义编译
   - 唤醒词"贾维斯"（MultiNet5 中文 `jia wei si`，阈值 15%）
   - Speaking 状态唤醒词打断（修改 application.cc 第915行）
   - 聆听模式唤醒词检测（CONFIG_WAKE_WORD_DETECTION_IN_LISTENING=y）
   - 上电预连接 WebSocket（修改 WebsocketProtocol::Start）
   - WiFi 通过 NVS 写入（/tmp/wifi_nvs.bin）
   - OTA URL 硬编码替换（api.tenclass.net → NAS IP:8105）
   - 分区表修改：v2/16m.csv，ota 各 3MB，assets 9.9MB
   - 源码：/tmp/xiaozhi-esp32/（编译环境：Docker espressif/idf:v5.5.2）

2. **Home Assistant**：Docker 部署，38 个米家设备 + 8 个易微联设备
   - 两个家庭分区：北京（12台）+ 杭州（20台，不操作）
   - Long-Lived Token：cc-mcp（10年有效）
   - 修复了 xiaomi_miot 插件 identity_session bug

3. **小智后端（旧）**：xiaozhi-esp32-server Docker
   - Gemini/MiniMax LLM + FunASR ASR + EdgeTTS
   - HA 控制 + xiaomusic 音乐播放
   - function_call 意图识别
   - **体验问题**：延迟 5-8 秒，不能流畅打断，一问一答模式

4. **jarvis-server v1（新）**：框架已搭建
   - WebSocket 服务兼容小智协议（hello/listen/audio）
   - MiniMax M2.7-highspeed LLM（流式 function calling）
   - Edge-TTS 语音合成
   - HA + xiaomusic 控制
   - **状态**：框架验证通过，待完善

5. **记忆系统 v5.5**：SQLite 统一存储已在 NAS 部署
   - memory.db（306条/30类别），向量索引 266 条
   - 三端同步：GitHub 每小时拉取 + 每天推送

---

## 当前最大的问题（要解决的）

**体验不够丝滑**。具体表现：
1. 说完话后要等 3-5 秒才有回复（ASR→LLM→TTS 串行）
2. 贾维斯说话时不能随时打断（虽然改了代码但 CustomWakeWord 打断不灵敏）
3. 不是双向流式的——不能像 Grok 那样随时说话随时回应

**根因**：小智后端是"一问一答"架构，不是为全双工实时交互设计的。

---

## 下一步工作

### P1：jarvis-server v1 完善（最高优先）

代码在 `2-Projects/jarvis-server/`

1. **ASR 对接**：当前用 Wyoming Whisper（端口 10300），延迟 0.3-0.5s，可接受
2. **流式 TTS**：Edge-TTS 生成 MP3 → ffmpeg 转 PCM → Opus 编码 → WebSocket 发送
   - 当前是等 TTS 完整生成再发——**改为边生成边发**
3. **VAD 打断**：在 TTS 播放过程中，检测到 Opus 音频帧有人声就停止发送
4. **LLM 流式回复**：MiniMax M2.7 已支持 stream，当前代码已实现
5. **tool_call 直接执行**：不走二次 LLM 调用，工具结果直接 TTS 输出

### P2：ESP32 固件适配

如果 jarvis-server 的协议和小智固件不完全兼容，需要改固件。
- 小智固件源码：/tmp/xiaozhi-esp32/
- 编译：`sudo docker run --rm -v /tmp/xiaozhi-esp32:/project docker.1ms.run/espressif/idf:v5.5.2 bash -c "pip install pyyaml; python3 scripts/release.py atk-dnesp32s3-box"`
- 刷固件：`~/.local/bin/esptool --port /dev/ttyACM0 --baud 460800 --chip esp32s3 write-flash ...`

### P3：MiniMax Speech 2.8 TTS

Token Plan 支持 speech-2.8-hd，但 API 调用返回 audio 为空。需要调试接口参数。
如果调通，可以替代 Edge-TTS 获得更好的音质。

---

## API 密钥

### MiniMax（主力，国内服务器，216ms 延迟）
- API Key：`sk-cp-QrDYLN3gmi9S6CkJu3uDtFA9U8yr1RPrCSg6kTw4_WfJTuU-_nMnNTMvgIt_ZbAgYae1YSJfCKsKfIeb8b-xW1HxpIwjKTSP7iwal49u5Z-dkyeb9Ox-TKc`
- Base URL：`https://api.minimax.chat/v1/text/chatcompletion_v2`
- 模型：`MiniMax-M2.7-highspeed`
- Token Plan：订阅制，M2.7 每 5 小时 1500 次请求
- TTS：speech-2.8-hd（待调通）
- **重要**：直连不走代理

### Gemini（备用，美国服务器，1s 延迟）
- API Key：`fq8-1NLtsbVsiJhZaISmNeobvqY0bIZMoafPnKfkuz4`
- Base URL：`http://23.226.135.149:4000/v1`
- 模型：gemini-2.5-flash
- **重要**：直连不走 xray 代理

---

## 延迟基准测试数据

| API | 网络 RTT | 纯文本首 token | function_call | TTS |
|-----|---------|--------------|---------------|-----|
| MiniMax（国内） | 216ms | ~1s | ~2.8s | 935ms |
| Gemini（美国直连） | 420ms | 1.0s | - | N/A |
| Gemini（走代理） | 850ms | 2.6s | 4.5s | N/A |
| FunASR 本地 | 0 | 0.1-0.5s | - | - |
| Edge-TTS | ~300ms | - | - | ~1s |

---

## 关键文件导航

```
2-Projects/jarvis-server/       ← 新后端（正在开发）
├── server.py                   # WebSocket 主服务
├── llm.py                      # MiniMax M2.7 流式 LLM
├── ha.py                       # HA + xiaomusic 控制
├── tts.py                      # Edge-TTS
├── config.py                   # 配置（API key、设备列表）
├── ota.py                      # 本地 OTA 服务
└── HANDOFF.md                  # 本文件

.claude/skills/cc-lite/         ← 旧方案相关
├── scripts/cc_lite.py          # cc-lite（Ollama 版，已弃用）
├── migpt/                      # migpt-next（小爱语音，已弃用）
├── xiaozhi-server/             # 小智后端配置
└── esp32/jarvis.yaml           # ESPHome 配置（已弃用）

/tmp/xiaozhi-esp32/             # 小智AI 固件源码（编译用）
/tmp/xiaozhi-esp32-server/      # 小智后端源码
```

---

## 决策记录

| 日期 | 决策 | 原因 |
|------|------|------|
| 03-25 | HA Docker 部署 | fnOS NAS 不支持 HassOS |
| 03-26 | 放弃 ESPHome 方案 | 正点原子 BOX1 引脚和乐鑫官方 BOX 不同，XL9555 IO 扩展器需要特殊初始化 |
| 03-30 | 基于小智AI 源码编译固件 | 复用小智的硬件驱动（XL9555+I2S），只改唤醒词和 OTA |
| 03-30 | 唤醒词用 MultiNet5 而非 WakeNet | CustomWakeWord 支持自定义拼音，WakeNet 只有固定词 |
| 03-31 | MiniMax 为主 API | 国内服务器 216ms 延迟，比 Gemini 代理快 4 倍 |
| 03-31 | 重构 jarvis-server | 小智后端一问一答架构无法达到 Grok 级体验 |
| 03-31 | 体验优先于速度 | 不为省 0.1s 牺牲交互自然度 |
