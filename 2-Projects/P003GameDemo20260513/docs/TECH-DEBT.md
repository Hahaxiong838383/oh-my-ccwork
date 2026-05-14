# 技术债清单（demo 完成 → 优化阶段处理）

> 沉淀时间：2026-05-14 D3 收工
> 处理时机：90 秒 demo 视频录完 + 公开演示后

---

## P1 · 优化阶段必修

### 1. PCM / Opus 替代 mp3（消除 priming silence）

**问题**：当前 TTS 用 mp3，每段独立 decode 开头有 ~10ms priming silence。
按句切段后占比 < 2% 不可感，但仍是 codec 限制。

**方案对比**：

| 方案 | 好处 | 代价 |
|------|------|------|
| **PCM 16bit** | 无 priming + 零解码开销 + 可走 AudioWorklet 真流式 | 带宽 6-10×（48KB/s vs 16KB/s），需重采样 24k→44.1k |
| **Opus** | 无 priming + 带宽接近 mp3 + iOS 支持 | 火山 Doubao-TTS 2.0 是否支持 opus 输出未验证 |

**推荐**：Opus（兼顾延迟、带宽、兼容性），先验证火山支持再切。

**工时**：1-2h（含端到端 + 听感校准）

**文件**：`apps/server/src/providers/volc-tts.ts:62` audio_params.format / `apps/web/src/services/voice-client.ts` playAudioChunk

---

### 2. iOS Safari 真机性能验证

**风险（codex P1 标 [未验证]）**：
- 32 粒子 + 7 烟花 + 震屏 infinite repeat 同时跑（legendary 宝箱场景）
- prefers-reduced-motion 检测是否 SSR-safe
- containerType: 'size' / cqw / cqh 在 iOS Safari 16+ 兼容
- AudioContext 解锁路径（playSfx 触发）

**验证方法**：
- iPhone Safari（推荐 iOS 16.4+ 与 17）连续切 boxCommon → boxRare → boxEpic → boxLegendary
- 关注 legendary 段是否掉帧
- 低端机 / 省电模式下更易暴露

**降级方案**：legendary 粒子数 32→16 / 烟花 7→4 / 给 iOS 加一级 reducedMotion 强制开

**工时**：30 分钟（真机测试） + 30 分钟（如需降级）

---

### 3. MiniMax-M2.7-highspeed provider 接入

**当前状态**：脱敏写入 `.env.local`，启用步骤沉淀到 mycc memory `reference_p003_minimax_llm_backup`。

**何时接入**：
- 长故事质量优先场景（demo 演示偏向 gemini-3.1 快速响应）
- 老板临时切换体验时

**实现步骤**（参考 memory）：
1. 写 `apps/server/src/providers/minimax-llm.ts`（参考 gemini-llm.ts 复制改）
2. `pipeline.ts` 加 `LLM_PROVIDER=gemini|minimax` 分支
3. 改 .env.local 切换

**工时**：30 分钟

---

## P2 · 优化阶段建议

### 4. xiaokeLine 文案源统一（codex P2）

**问题**：`apps/web/src/scenes/OpenBox.tsx` 直接读 `BOX_LEVELS[level].xiaokeLine`，
而 reward-machine effect 也 setSubtitle 同样文案。两个数据源未来改一处忘改另一处会分叉。

**修复**：让 OpenBox 读 `useAppStore(s => s.subtitle)` 替代直接读 BOX_LEVELS。

**工时**：15 分钟

---

### 5. focusMachine paused 分支无闭环（codex P2）

**问题**：`focus-machine.ts:41` PRESENCE_LOST → paused 转换存在，但 PRESENCE_BACK 没有触发入口，
pauseDetect timer 在 demo 模式被显式忽略。

**修复**：
- 短期：演示场景下 paused 状态不会触发（demo 永远在线），不影响 demo
- 长期：硬件版本接入摄像头存在感知后启用

**工时**：D4 demo 阶段不修

---

### 6. 遗留未接入主流程的模块（codex P2）

**清单**：
- `apps/web/src/components/ConfirmModal.tsx`（未引用）
- `apps/web/src/components/ScreenOverlayHost.tsx`（未引用）
- `apps/web/src/systems/voice/index.ts`（routeIntent / speak / isVoiceSupported 未引用）
- `apps/web/src/components/WizardOfOz.tsx`（D1 mock 控制器，已被 DebugBar 接管但保留）

**修复**：demo 完成后做 dead code 扫描，删或归档

**工时**：1h（含审计 + 决定保留/删除）

---

## P3 · 锦上添花（可选）

### 7. 陀螺仪视差（D5 buffer）
手机倾斜时小可/背景做轻微视差移动，增加沉浸感。

### 8. 摸头反馈（D5 buffer）
点击小可 → 小可眨眼/微笑/上下弹跳反馈。

### 9. SettingsPanel 4 项 UI 进度条/开关 polish
D4 下午做完基础 UI 后，量产前精修动效。

### 10. 烟花颜色随机化
当前 legendary 烟花是 4 色 palette 循环，可改成完全随机色相 + 渐变。

---

## 处理时机

```
D4 上午: 部署 VPS + iOS 真机 → P1.2 验证
D4 下午: SettingsPanel + 录视频
D5 buffer: 兼容性 + 文档收尾 + P3.7/8 可选
─────────────────────────────────────
demo 公开 / 录完视频
─────────────────────────────────────
优化阶段: P1.1 (Opus) → P1.3 (MiniMax) → P2.4 → P2.6
```

---

**沉淀人：cc（Claude Opus 4.7）| 2026-05-14**
