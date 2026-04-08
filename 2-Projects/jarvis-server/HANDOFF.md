# HANDOFF — 贾维斯语音系统跨 session 交接文档

> **新 session 接手时先读这个文件。**
> 最后更新：2026-04-01

---

## 项目目标

**O1**：实现 Grok 级丝滑语音交互——随时说话、随时打断、<2秒响应、自然对话

**O2**：
- 不绑定特定实现方案（ESP32 / 树莓派 / 安卓均可评估）
- ESP32 固件可改，也可换硬件
- 零本地大模型算力（NAS i5-8500 性能有限）
- 以 MiniMax M2.7 为主 API

---

## 当前状态总结（2026-04-01）

### 已完成 ✅

**jarvis-server v1 后端**（代码在 `2-Projects/jarvis-server/`）：
- 全流式架构：LLM 流式出字 → 按句切分 → 每句立即 TTS → Opus 编码 → WebSocket 发送
- MiniMax M2.7 异步流式 LLM（aiohttp）
- FunASR SenseVoice 中文 ASR（准确率高，CPU 推理 ~1.5s）
- Edge-TTS 流式管道（ffmpeg 管道预热）
- HA 智能家居控制 + xiaomusic 音乐播放
- 服务端 VAD（能量检测，静默 800ms 自动停止）
- 小智协议兼容：hello/listen/abort/audio，v1/v2/v3 二进制协议头
- session_id、emoji 过滤、TTS 预热

**ESP32 固件**：
- 小智AI v2.2.4 fork，自定义编译
- 唤醒词 "贾维斯"（MultiNet5，阈值 5%）
- WiFi + OTA + WebSocket 全部通过 NVS 配置
- 源码：/tmp/xiaozhi-esp32/
- 编译产物：/tmp/xiaozhi-esp32/releases/v2.2.4_atk-dnesp32s3-box.zip

**FunASR 环境**：
- venv 在 `2-Projects/jarvis-server/venv/`
- torch 2.11.0+cpu + funasr 1.3.1 + SenseVoiceSmall 模型
- 模型缓存：~/.cache/modelscope/hub/models/iic/SenseVoiceSmall/

### 端到端验证结果

| 测试项 | 结果 | 备注 |
|--------|------|------|
| WebSocket 握手 | ✅ | hello 协议兼容 |
| 合成语音 ASR | ✅ | FunASR 识别 "打开客厅灯" 正确 |
| 真人语音 ASR | ✅ | "贾维斯贾维斯喂喂喂贾维斯" 完全正确 |
| LLM 流式回复 | ✅ | MiniMax M2.7 正常 |
| HA 设备控制 | ✅ | 客厅灯开关成功 |
| TTS 音频回放 | ✅ | ESP32 喇叭能听到回复 |
| 服务端 VAD | ✅ | 静默 800ms 自动触发 |
| **唤醒词 "贾维斯"** | ❌ | MultiNet5 不可靠，阈值降到 5% 仍不灵敏 |
| **设备连接稳定性** | ❌ | 反复连接断开（5秒断一次） |

### 延迟实测数据

| 环节 | 耗时 | 备注 |
|------|------|------|
| FunASR 冷启动 | ~7s | 首次推理，后续 ~1.5s |
| FunASR 热推理 | ~1.5s | CPU i5-8500 |
| MiniMax LLM 首句 | ~2.3s | 含 function_call |
| Edge-TTS 首音频 | ~1.4s | 每句独立连接 |
| **端到端首音频** | **~5.3s** | 目标 <2s |

---

## 核心问题（待解决）

### 1. 唤醒词不可靠（阻塞项）

ESP32 MultiNet5 自定义中文唤醒词 "贾维斯" 准确率极低：
- 阈值从 15% 降到 5%，仍然几乎无法触发
- 内置词 "你好小智" 准确但不符合需求
- **根因**：MultiNet5 命令词识别不适合做唤醒词，三音节自定义词匹配率天然低

### 2. 设备连接不稳定

ESP32 连接 jarvis-server 后频繁断开（5秒内断开重连）：
- 可能是 hello 响应缺少某些字段
- 可能是心跳/ping-pong 机制缺失
- 需要对比小智原版服务端的行为

### 3. 端到端延迟偏高（5.3s，目标 <2s）

瓶颈分解：
- ASR 1.5s：换流式 ASR 可以边说边识别
- LLM 2.3s：MiniMax 国内服务器已经很快
- TTS 1.4s：Edge-TTS 每句新建连接有开销

---

## 下一步工作

### 方向一：继续 ESP32 方案优化

需要研究：
- 小智固件的 WakeNet（AFE 唤醒词）模式是否更可靠
- 连接断开的根因（对比小智原版后端的心跳机制）
- 是否能在 ESP32 上做本地 VAD 然后发 listen stop（减少服务端 VAD 延迟）

### 方向二：树莓派方案（推荐评估）

优势：
- openWakeWord 自定义唤醒词准确率 >95%
- 本地跑 SenseVoice ASR（~0.5s）
- Linux 生态，jarvis-server 直接跑在上面
- 更好的麦克风阵列 + 喇叭选择

待评估：具体型号、配件、成本

---

## 架构全景

```
ESP32 BOX1（正点原子 DNESP32S3B）
  固件：小智AI v2.2.4 + 自定义唤醒词"贾维斯"（MultiNet5，阈值5%）
  WiFi：NETGEAR，密码：1984022919
  OTA：http://192.168.1.115:8105/xiaozhi/ota
  USB：Slave 口连 NAS（/dev/ttyACM0）
    ↓ WebSocket（Opus 音频）
NAS（飞牛 fnOS，i5-8500，16GB RAM）
  ├── jarvis-server v1（端口 8201）← 新后端，FunASR + 流式 TTS
  ├── FunASR SenseVoice（venv，CPU 推理）
  ├── xiaozhi-esp32-server（端口 8100，Docker）← 旧后端
  ├── Home Assistant（端口 8123，Docker）
  ├── xiaomusic（端口 58090，Docker）
  ├── OTA 服务（端口 8105）
  ├── mycc 后端（端口 18080）
  └── Wyoming Whisper（端口 10300）← 已弃用，换 FunASR
```

---

## 关键文件导航

```
2-Projects/jarvis-server/       ← 新后端
├── server.py                   # WebSocket 主服务（流式管线 + 服务端 VAD）
├── llm.py                      # MiniMax M2.7 异步流式 LLM
├── ha.py                       # HA + xiaomusic 控制
├── tts.py                      # Edge-TTS 流式管道 + 预热
├── config.py                   # 配置（API key、设备列表）
├── ota.py                      # 本地 OTA 服务
├── venv/                       # Python venv（torch + funasr）
├── requirements.txt            # 依赖
└── HANDOFF.md                  # 本文件

/tmp/xiaozhi-esp32/             # 小智AI 固件源码
├── sdkconfig                   # 编译配置（唤醒词阈值等）
├── main/audio/wake_words/      # 唤醒词实现
├── main/protocols/             # WebSocket 协议
└── releases/                   # 编译产物

/tmp/new_nvs2.bin               # 最新 NVS 配置（WiFi+OTA+WebSocket）
/tmp/esp32_boot.log             # ESP32 启动日志
```

---

## API 密钥

### MiniMax
- API Key：`sk-cp-QrDYLN3gmi9S6CkJu3uDtFA9U8yr1RPrCSg6kTw4_WfJTuU-_nMnNTMvgIt_ZbAgYae1YSJfCKsKfIeb8b-xW1HxpIwjKTSP7iwal49u5Z-dkyeb9Ox-TKc`
- Base URL：`https://api.minimax.chat/v1/text/chatcompletion_v2`
- 模型：`MiniMax-M2.7-highspeed`
- **直连不走代理**

### Gemini（备用）
- API Key：`fq8-1NLtsbVsiJhZaISmNeobvqY0bIZMoafPnKfkuz4`
- Base URL：`http://23.226.135.149:4000/v1`
- 模型：gemini-2.5-flash

---

## 决策记录

| 日期 | 决策 | 原因 |
|------|------|------|
| 03-31 | MiniMax 为主 API | 国内服务器 216ms 延迟 |
| 03-31 | 重构 jarvis-server 全流式 | 小智后端一问一答架构无法达到目标 |
| 03-31 | requests → aiohttp | 同步 HTTP 阻塞事件循环 |
| 03-31 | FunASR 替代 Whisper | Whisper 幻听严重，FunASR 中文准确 |
| 04-01 | 唤醒词阈值 15% → 5% | 提高灵敏度（效果仍不理想） |
| 04-01 | 评估树莓派方案 | ESP32 MultiNet5 唤醒词不可靠，硬件能力瓶颈 |
