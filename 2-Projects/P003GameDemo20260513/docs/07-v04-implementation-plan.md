# 07 · V0.4 实施计划（4 天交付版）

> 2026-05-13 晚 · cc 综合 codex（技术选型）+ gemini（4 天范围评审）双路调研，给川哥的最终方案。
> 调研原文：[/tmp/codex_voice_research_result.md](#) + [/tmp/gemini_clean.md](#)（内部留档）

---

## 一、核心决策（合二为一）

### 1. 技术选型（采用 codex 首选）

| 层 | 选择 | 延迟分担 | 备注 |
|---|---|---|---|
| **STT** | **火山引擎流式 ASR**（WebSocket，PCM 100ms 分片） | 400-700 ms | 国内直连，无代理 |
| **LLM** | **豆包 Chat 流式**（火山方舟 API） | 300-500 ms TTFT | 输出结构化 `{text, emotion, action}` |
| **TTS** | **火山引擎 TTS v3 双向流式** | 300-500 ms 首包 | 文本增量 → 音频增量边出边播 |
| **传输** | WebSocket（前端 ↔ 后端） | 50-100 ms | 单一连接复用 |
| **打断** | sessionId + turnId + abort 信号 | — | 用户插话立即停播+清缓冲 |

**端到端目标**：1.5-2.5 s（gemini 警告"≤1.5s 物理上不可能纯靠拼装"是对的，但**配合"延迟掩盖术"可以让 2.5s 体感等同 1s**）

**备选**：豆包 Realtime（RTC 一体化）—— 如果 D1 火山三段权限当天开不通就切。

### 2. 范围裁剪（采纳 gemini 毒舌建议）

| 变更 | V0.3 计划 | V0.4 修订 | 理由 |
|---|---|---|---|
| 渲染引擎 | PixiJS（生态缸/小可帧动画） | **CSS Sprite Sheet + Lottie（or mp4 背景）** | gemini："4 天 PixiJS 是定时炸弹" |
| 状态管理 | Zustand 多 store | **React useState 一把梭，必要时单一全局 store** | "4 天的代码就是用来扔的" |
| 状态机 | XState 4 个 | **简单 status 字符串字段** | 砍 |
| 语音 | 唤醒词 + VAD | **Push-to-talk（按住说话）** | gemini："别自己写 VAD"，回声/打断地狱 |
| 配置表 | 9 张 Zod 校验 | **直接 hardcode** | demo 第一 |
| 存档 | Dexie 3 份冗余 | **localStorage 单份**（或不存） | demo 不需要 |
| **新增（强制）** | — | **Wizard of Oz 兜底**：键 1/2/3 触发预录音频；3s 超时切本地 fallback | gemini："必须有不用网也能演完的备用剧本" |

---

## 二、项目架构

```
┌──────────────────────────────────────────────────────────┐
│ 手机浏览器（横屏强制）                                     │
│ ┌──────────────────────────────────────────────────────┐ │
│ │  设备外壳 + LED + 麦克风孔                            │ │
│ │  ┌────────────────────────────────────────────────┐  │ │
│ │  │  800 × 300 横屏画布（屏幕区域）                 │  │ │
│ │  │   - 静态生态缸背景图（一张 PNG）                │  │ │
│ │  │   - 小可雪碧图（CSS animation: steps）          │  │ │
│ │  │   - 双货币胶囊（静态数字）                      │  │ │
│ │  │   - 字幕区（小可说的话）                        │  │ │
│ │  │   - Push-to-talk 按钮（按住说话）               │  │ │
│ │  │   - 状态指示（聆听/思考/回答中）                │  │ │
│ │  └────────────────────────────────────────────────┘  │ │
│ └──────────────────────────────────────────────────────┘ │
└────────────────┬─────────────────────────────────────────┘
                 │ WebSocket（PCM16 二进制 + JSON 控制帧）
                 ▼
┌──────────────────────────────────────────────────────────┐
│ 后端 (Bun + Hono + ws)                                    │
│  - /ws/voice         WebSocket 入口                       │
│  - /api/health       探活                                  │
│                                                            │
│  voice-pipeline:                                          │
│    1. 接 PCM chunk → 转发到火山 ASR WS                    │
│    2. ASR partial/final → 发回前端 + 触发 LLM             │
│    3. 豆包 LLM 流式 → 解析结构化 (text/emotion/action)    │
│    4. text 增量 → 火山 TTS WS                             │
│    5. TTS audio 增量 → 发回前端                           │
│    6. 任意时刻 user.interrupt → abort 当前 turn          │
└──────────────────────────────────────────────────────────┘
                 │
                 ▼
   火山引擎 ASR / 豆包 LLM / 火山引擎 TTS
```

### 文件树（V0.4 简化版）

```
P003GameDemo20260513/
├── docs/                       已有（V0.1-V0.4）
├── apps/
│   ├── web/                    前端（V0.2-V0.3 骨架 + V0.4 精简）
│   │   ├── src/
│   │   │   ├── App.tsx         一文件主入口（useState 一把梭）
│   │   │   ├── device/         设备外壳 + LED（保留）
│   │   │   ├── components/     扁平组件（不分 scenes）
│   │   │   │   ├── Xiaoke.tsx          小可 CSS sprite + emotion
│   │   │   │   ├── EcoBackground.tsx   生态缸 PNG 背景
│   │   │   │   ├── CoinHud.tsx         双货币胶囊
│   │   │   │   ├── VoiceButton.tsx     Push-to-talk 按钮
│   │   │   │   ├── Subtitle.tsx        小可说话字幕
│   │   │   │   ├── FocusFlow.tsx       专注循环 setTimeout 模拟
│   │   │   │   └── WizardOfOz.tsx      键盘后门（隐藏，按 1/2/3 触发预录）
│   │   │   ├── voice-client.ts         WebSocket 客户端 + AudioWorklet
│   │   │   ├── audio/                  本地兜底音频文件
│   │   │   │   ├── fallback_busy.mp3
│   │   │   │   ├── preset_1.mp3        预录"你好指挥官"
│   │   │   │   ├── preset_2.mp3        预录"开始专注吧"
│   │   │   │   └── preset_3.mp3        预录"今天真棒"
│   │   │   └── styles.css
│   │   ├── public/
│   │   │   ├── xiaoke/                 小可雪碧图（4-6 帧 PNG）
│   │   │   ├── eco/                    生态缸背景图 PNG
│   │   │   └── treasure.lottie         宝箱 Lottie JSON（可选）
│   │   ├── index.html
│   │   └── package.json
│   └── server/                 ★ V0.4 新增
│       ├── src/
│       │   ├── index.ts        Bun + Hono 入口
│       │   ├── ws-voice.ts     WebSocket 语音中转
│       │   ├── providers/
│       │   │   ├── volc-asr.ts    火山 ASR WS 客户端
│       │   │   ├── doubao-llm.ts  豆包 Chat 流式
│       │   │   └── volc-tts.ts    火山 TTS v3 双向流
│       │   ├── pipeline.ts     语音管线协调器（含打断）
│       │   └── protocol.ts     WS 消息 schema (Zod)
│       ├── .env.example        VOLC_ACCESS_KEY / VOLC_SECRET_KEY / DOUBAO_API_KEY
│       └── package.json
└── package.json
```

---

## 三、功能列表与优先级

### P0 · 必须做（缺一不可）

| # | 功能 | 验收点 |
|---|---|---|
| P0-1 | 800×300 横屏画布 + 设备外壳 | 手机横置看到外壳+5:3屏幕（实际 8:3）正确显示 |
| P0-2 | **小可 AI 实时语音对话**（火山三段，push-to-talk） | 按住按钮说话→松开→1.5-2.5s 内听到小可回答 |
| P0-3 | 小可情绪/动作反馈（来自 LLM 结构化输出） | 不同对话内容触发不同表情/动作（哪怕 3 种枚举） |
| P0-4 | **Wizard of Oz 兜底**（键 1/2/3 + 网络超时 fallback） | 拔网线也能演完一遍循环 |

### P1 · 强烈应做（不做 demo 体验差但能跑）

| # | 功能 | 验收点 |
|---|---|---|
| P1-1 | 主界面静态视觉（生态缸 PNG + 双货币胶囊） | 视觉成立，不需可交互 |
| P1-2 | 小可待机动画（CSS sprite 3-4 帧循环） | 不说话时小可在呼吸/眨眼 |
| P1-3 | 专注循环（开始 → 倒计时秒级 → 结束 → 简易宝箱） | 跑通核心闭环 |
| P1-4 | 字幕（小可说话同步显示文字） | 增强可读性，应对环境嘈杂 |
| P1-5 | 状态指示（聆听中/思考中/回答中） | gemini 的"延迟掩盖术"核心 |

### P2 · 锦上添花（时间允许才做）

| # | 功能 | 验收点 |
|---|---|---|
| P2-1 | 宝箱 Lottie 开箱动画 | 视觉爽点 |
| P2-2 | 通用 Tips 复用 V0.3 写好的 | 已就绪，挂上即可 |
| P2-3 | 数字滚动跳动（开箱后货币 +N） | react-spring 一行搞定 |
| P2-4 | 简单本地存档（localStorage 货币数） | 刷新不丢 |
| P2-5 | LED 灯随小可情绪变色 | 工业感 |

### P3 · 不做（V1.0 重启动）

唤醒词、VAD、回声消除、4 级宝箱、生态缸 5 部件 × 3 级、男女差异、性别选择、新手期、设置面板、夜航报告完整、藏品、抽卡、任务系统、状态机、配置表 Zod、3 份存档、PWA、所有 V1.5+ 模块

---

## 四、4 天工期切分

### D1 · 链路日（破除 AI 幻觉）

**目标**：CLI 能跟 AI 完整对话一次。

- **上午**：
  - [ ] 后端 `apps/server` 骨架（Bun + Hono + ws + dotenv）
  - [ ] 火山引擎 + 豆包账号确认 + .env 配齐
  - [ ] `providers/volc-asr.ts` 起步：能把一段本地 PCM 文件喂进去拿到识别结果
  - [ ] `providers/doubao-llm.ts` 起步：CLI 输入文字得到流式回答
  - [ ] **D1 中午止损点**：如果火山权限当天开不通 → 立即切 MiniMax 备选
- **下午**：
  - [ ] `providers/volc-tts.ts` 起步：CLI 给一段文字得到 mp3
  - [ ] 用一个 `apps/server/scripts/cli-chat.ts` 把三段串起来：键盘输入→ASR→LLM→TTS→播放
  - [ ] 前端 `apps/web` 改 800×300 + 强制横屏 + 静态外壳

**D1 里程碑**：终端能 "你好" → 小可（声音）回答。前端能看到 800×300 设备外壳。

### D2 · 声画日（最痛苦的一天）

**目标**：前端可以跟小可说话听到回答。

- **上午**：
  - [ ] 后端 WebSocket 端点 `/ws/voice`（消息协议见下文 §五）
  - [ ] 前端 `voice-client.ts`：getUserMedia + AudioWorklet 录 PCM16
  - [ ] WebSocket 把 PCM 二进制送到后端
- **下午**：
  - [ ] 后端管线串起来（PCM → ASR → LLM → TTS → audio chunk 回前端）
  - [ ] 前端用 AudioContext 播 TTS 流（边收边播）
  - [ ] **死命令**：不写 VAD，**Push-to-talk**（按住按钮录音，松开提交）
  - [ ] **D2 下午 4 点止损**：如果声画对不上，立刻切纯 HTTP 短轮询版本

**D2 里程碑**：手机浏览器（本地内网）按住按钮说话能听到小可回答。

### D3 · 拼图日（造假大师 + 延迟掩盖）

**目标**：演出体感成立。

- **上午**：
  - [ ] 前端补完静态视觉（生态缸 PNG + 双货币胶囊 + 小可 sprite）
  - [ ] 字幕组件：小可说话时同步显示文字
  - [ ] 状态指示（"小可正在听..." / "小可在想..." / "小可正在说"）
- **下午**：
  - [ ] **延迟掩盖术**实现：
    - 用户松开按钮的瞬间，小可立刻播一段本地"嗯..."音频 + 思考表情
    - LLM 首字到达，"嗯..."自然过渡到真回答
    - 让 2.5s 体感 = 1s
  - [ ] **打断**：用户再次按下按钮 → 后端 abort 当前 turn + 前端清音频缓冲
  - [ ] 专注循环：按钮触发 setTimeout(3s) → 弹宝箱 → 货币+10

**D3 里程碑**：完整体验闭环（说话→回答→开始专注→倒计时→宝箱→货币）。

### D4 · 演出日（排练 + 兜底 + 上云）

**目标**：手机扫码 → 公网体验 → 川哥验收通过。

- **上午**：
  - [ ] **Wizard of Oz**：
    - 隐藏区域键盘按 1/2/3 触发预录音频（无网也能演）
    - WebSocket 断或超过 3s 无响应 → 自动切本地兜底（gemini 的"信号飘外太空"剧本）
  - [ ] 至少 3 条"必通对话路径"提前测好（demo 时只演这 3 条）
- **下午**：
  - [ ] 后端上云（VPS / Cloudflare / Vercel）
  - [ ] 前端部署（同上）
  - [ ] 手机扫码真机测试 3 轮（iOS Safari + Android Chrome 各一）
  - [ ] 录 60s demo 视频备用

**D4 里程碑**：川哥手机扫码 → 横屏 → 完整跑一遍 → 验收通过。

---

## 五、WebSocket 协议契约

来自 codex 调研（与 V0.3 docs/05-server-contracts 一致延伸）：

```ts
// 客户端 → 服务器
{ type: 'session.start', sessionId, sampleRate: 16000, format: 'pcm16' }
{ type: 'audio.chunk', sessionId, seq, ts, data_base64 }
{ type: 'audio.end', sessionId, turnId }              // push-to-talk 松开
{ type: 'user.interrupt', sessionId, reason: 'barge_in' }

// 服务器 → 客户端
{ type: 'asr.partial', sessionId, seq, text }
{ type: 'asr.final', sessionId, seq, text }
{ type: 'npc.reply.delta', sessionId, turnId, textDelta, emotion?, action? }
{ type: 'tts.audio.chunk', sessionId, turnId, audio_base64, codec: 'mp3'|'pcm', isFinal: false }
{ type: 'tts.audio.end', sessionId, turnId }
{ type: 'turn.done', sessionId, turnId, latency: { asr_ms, llm_ms, tts_ms, e2e_ms } }
{ type: 'error', sessionId, code, message, retriable }
```

`emotion` ∈ `'happy' | 'curious' | 'warm' | 'calm' | 'excited'`
`action` ∈ `'wave' | 'nod' | 'think' | 'cheer' | 'idle'`

前后端**契约稳定**，前端可在 D1 用 mock data 先撸 UI，D2 切真后端。

---

## 六、风险清单（合并 codex + gemini）

| # | 风险 | 致命度 | 对策 |
|---|---|---|---|
| R1 | **火山/豆包账号权限当天开不通** | ★★★★★ | D1 中午止损点 → 切 MiniMax 备选 |
| R2 | **Web 端 VAD/AEC 地狱（小可自己跟自己对话）** | ★★★★ | 直接 push-to-talk，TTS 播放时硬禁麦克风 |
| R3 | **iOS Safari 自动播放策略** | ★★★★ | 首屏用户手势解锁 AudioContext，统一队列 |
| R4 | **打断不干净（叠音）** | ★★★ | turnId 代际控制 + abort 信号 + 旧包丢弃 |
| R5 | **演示现场网络抖动 / API 抽风** | ★★★★★ | Wizard of Oz 兜底（键盘 1/2/3 + 3s 超时本地播） |
| R6 | **第二天还在调 VAD** | ★★★★ | D2 下午 4 点止损 → 切 push-to-talk |
| R7 | **PixiJS 调试耗时** | ★★★ | 直接拔掉，CSS sprite 一把梭 |
| R8 | **状态管理过度** | ★★ | useState 一把梭，单文件 App.tsx |

---

## 七、执行原则（每天醒来对照）

1. **跑起来 > 完美** —— 复杂度即敌人
2. **演出 > 工程** —— Demo 是给老板看的，不是给同行看的
3. **延迟掩盖 > 真实低延迟** —— 物理打不过感官
4. **预录兜底 > 全靠 API** —— 永远要有不用网的剧本
5. **三条必通路径 > 自由发挥** —— 演 demo 不是开放探索

每天结束追加一条日志到 `docs/D{N}-log.md`。

---

## 八、当前已就绪 vs 待启动

### V0.3 已完成（可直接复用）

- ✅ 设备外壳 (`apps/web/src/device/DeviceFrame.tsx`)
- ✅ 800×480 → V0.4 改成 800×300（已 done tailwind.config.js）
- ✅ Tips + ConfirmModal 通用组件
- ✅ user-store / settings-store / device-store（V0.4 简化使用）
- ✅ 文档完整（00-06 + DEMO-PRINCIPLES）

### V0.4 待启动

- ⏳ **apps/server/** 完整后端（D1 启动）
- ⏳ 火山 + 豆包账号权限 & API Key（**川哥需要先准备好** ← 这是 D1 启动的必要前提）
- ⏳ 小可雪碧图美术资源（占位可以先用色块）
- ⏳ 生态缸背景 PNG（占位用渐变）

---

## 九、对川哥的请求

**D1 启动前必须就位的资源**：

1. **火山引擎账号** + 实名 + 开通：
   - 流式 ASR（doc 6561/80818）
   - 火山方舟豆包 LLM（API Key）
   - 流式 TTS v3 双向流（doc 6561/79821）
2. **MiniMax 备选凭据**（已有 mmx-cli，确认账号有 STT/TTS 权限）
3. **本地开发机**：Bun 已装（或 `curl -fsSL https://bun.sh/install | bash`）
4. **手机和电脑同网段** —— D2 真机调试用
5. **云端部署目标**：是用川哥 VPS（47.84.204.175 / hahafeiniu2）还是 Vercel/Cloudflare？提前定

**验收路径预定**：
- D2 晚上：内网 (`pnpm dev --host`) 手机扫码，本地 demo
- D4 下午：公网 URL 手机扫码，正式 demo

请川哥确认上述清单 + 选择云端部署目标，我就开干 D1。

---

> 这份计划**优先级**：每天结束前都对照 [DEMO-PRINCIPLES](DEMO-PRINCIPLES.md) §四 4 条检查。
> 任一项偏离 → 立刻砍范围，不堆功能。
