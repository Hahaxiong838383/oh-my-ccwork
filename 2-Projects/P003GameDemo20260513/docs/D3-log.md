# D3 完整日志 · V0.6 → V0.7（剧情场景 + 演示链路打通）

> 起止：2026-05-14 下午 → 晚上
> 工时：实际 ~5h（计划 6h，team 协作效率约 2x）
> 提交：7 个 commit（25a61d6b → 046e5a0d）

---

## 一、本日完成

### A. D3 计划主线（OpenBox/EcoUnlock/Farewell 三场景）
| 内容 | 实现 | 行数 |
|------|------|------|
| OpenBox 4 级差异化 + 32 粒子 + 烟花 + 震屏 + reward HUD | codex 后台撰写 | 205 |
| EcoUnlock 4 秒分段 + 鱼游 + 灯亮 | codex 后台撰写 | 111 |
| Farewell 关盖告别 + 关机黑屏 + slogan | codex 后台撰写 | 89 |
| 接线：store farewellState + reward-machine rewardShown timer + jumpToScene 触发 + DeviceFrame 挂载 + e2e C4 断言 | cc 主线 | ~120 |

### B. 演示翻车隐患 3 P1（codex 广角审查→cc 整改）
1. 跳关污染（在途语音回包改新场景 subtitle/voiceStatus）→ voice-client singleton + jumpToScene bargeIn
2. 设置按钮死按 → 改成 pushTip 占位反馈
3. WS 断连首按失败 → 加 isConnected() 实时查询，删 connectedRef

### C. 字幕容器溢出画布 P0（cc 实测发现）
- framer-motion `animate.y=0` inline transform 覆盖 tailwind `-translate-x-1/2`
- 修复：x:'-50%' 写进 motion keyframes

### D. 真机演示 3 大调试链路（老板真机反馈）
| Bug | 根因 | 修复 |
|-----|------|------|
| TTS 只播"指挥官，"就停 | Doubao-TTS 2.0 event 351 是句末中段不是流结束，被误识别 + pipeline endSent guard 锁死后续 audio | volc-tts.ts 区分 EVENT_TTS_SENTENCE_END_MID (351) vs EVENT_SESSION_FINISHED (152) |
| 讲故事被截断 ≤30 字 | max_tokens=120 + system prompt 硬限制"每次 ≤30 字" | max_tokens 按模型动态取上限 + system prompt 自适应（日常 30-50 字 / 故事 200-500 字） |
| 字幕飞过 1-2s 后 TTS 才开口 | voice-client mp3 flush 是防抖模式（每 chunk reset 350ms），TTS chunk 持续永不 flush | 防抖 reset → 绝对延迟（不 reset）+ server 端 tts.sentence_break 信号触发按句切 flush |

### E. LLM 多模型 benchmark（gemini-3.1-flash-lite-preview 默认）
| 模型 | max_tokens | 日常 TTFT | 故事 TTFT | 故事字数 |
|------|-----------|-----------|----------|----------|
| **gemini-3.1-flash-lite-preview** 🥇 | 65535 | **0.80s** | **0.97s** | 490 |
| gemini-2.5-flash-lite (旧默认) | 65535 | 1.14s | 0.92s | **776** |
| MiniMax-M2.7-highspeed | **196608 (192K)** | - | 2.01s | 600 (markdown) |
| gemini-2.5-flash | 65535 | 2.73s | 28s ❌ | thinking 未关 |
| gemini-3-flash-preview | 65535 | 3.65s | 5.05s | 545 |

切到 `gemini-3.1-flash-lite-preview`。MiniMax 脱敏写入 .env.local 备选，
按需启用步骤沉淀到 mycc memory `reference_p003_minimax_llm_backup`。

---

## 二、Team 协作链路

| 角色 | 工作 | 产出 |
|------|------|------|
| **cc 主线** | 拆解任务 + 接线 + 状态机 + e2e 断言 + 集成 | 全程串场 |
| **codex (后台)** | 写 D3 3 组件（405 行）+ 对抗审查 D3 全套（5 finding） | 组件 + 审查 |
| **gemini-3-flash-preview** | 视觉品味审 3 组件（3 建议全接受） | UX 改进 |
| **cc 自验** | playwright + 多时点截图 + dom_inspect + 三门 build/tsc/check:scope | 验收门 |

**审查发现**（按级别）：
- **gemini 3 建议（全接受）**：legendary 圆环 1.95→3.5 + brightness 1.5、EcoUnlock opacity 0.16→1、slogan duration 0.3→2.5s
- **codex 5 finding**：2 P1 已修（双行字幕 / opacity 重复）、1 P1 留 D4（iOS 性能未验证）、2 P2 已修/已接受设计
- **cc 主动发现**：字幕容器溢出 P0（dom_inspect 探针定位）

---

## 三、本轮关键经验沉淀（→ mycc memory）

1. **feedback_volc_tts_event_351_mid**：Doubao-TTS 2.0 event 351 是句末中段不是流结束
2. **feedback_tts_streaming_sentence_break**：mp3 流式播放必须靠句末信号分段，时间防抖 reset 是反模式
3. **feedback_llm_per_model_max_tokens**：max_tokens 按模型上限动态取，system prompt 不要硬限制字数
4. **reference_p003_minimax_llm_backup**：MiniMax-M2.7-highspeed 备选启用步骤
5. **feedback_framer_motion_tailwind_translate**：framer-motion `animate` inline transform 覆盖 tailwind translate utility

---

## 四、技术债（D5 优化阶段考虑）

详见 `docs/TECH-DEBT.md`：
- PCM/Opus 替代 mp3（消除 priming silence + 降解码开销）
- iOS Safari 性能真机验证（32 粒子 + 7 烟花 + infinite repeat）
- MiniMax provider 接入（按需启用）
- xiaokeEmotion + boxes.xiaokeLine 文案源统一
- settingsOpen / ConfirmModal / ScreenOverlayHost / voice-system 遗留模块审计

---

## 五、commit 序列

```
046e5a0d fix(P003): 真机演示三大调试链路修复（TTS/LLM/字幕同步）
cae1b7da feat(P003): D3 三场景 OpenBox/EcoUnlock/Farewell + codex+gemini 双线审查
97561704 fix(P003): D3 前演示翻车隐患整改（codex 广角审查 3 P1 + e2e C3）
c43370ec fix(P003): StatusBar 字幕容器溢出画布右边（P0 演示翻车）
7959cb38 refactor(P003): 状态机分叉收敛到 focusMachine + e2e 全链路断言
25a61d6b fix(P003): codex review 整改 3 项 + 自测验收
7ab499fb docs(P003): D2 进度日志 V0.4→V0.6 + 9 bug 真机复盘 + 后续 TODO
```

---

## 六、D4-D5 待办

### D4 上午 · 部署 + iOS 真机
- 部署阿里云 VPS：HTTPS + nginx WSS 反代 + 系统代理 NO_PROXY 固化
- iOS Safari 真机测：32 粒子 + 7 烟花 + 无限震屏 是否流畅
- iOS 后台节流处理（页面 visibilitychange 暂停 timer）
- 音频 buffer 释放（barge-in 后立刻 revokeObjectURL）
- 麦克风权限拒绝引导

### D4 下午 · SettingsPanel + 录视频
- SettingsPanel 完整 4 项 UI（齿轮按钮 + 顶部下拉手势）
- 录 90s demo 视频（按 docs/09-v06-implementation-plan §六脚本）
- 3 条兜底脚本（万一现场翻车）

### D5 buffer · 兼容性 + 文档
- iOS Safari 兼容性 polish
- 文档收尾 + commit/push
- 锦上添花：陀螺仪视差 / 摸头反馈（可选）

### 美术资源替换（老板亲自做）
- emoji 占位 → PNG/SVG（小猫 🐱、宝箱 📦、月亮 🌕、鱼 🐟、灯）
- 不阻塞 cc 任何任务，组件接口已留好（只需替换 `<span>📦</span>` → `<img src>` / SVG）

---

**署名：cc（Claude Opus 4.7）+ codex（OpenAI Codex）+ gemini（Google Gemini）| 完成时间：2026-05-14 21:00**
