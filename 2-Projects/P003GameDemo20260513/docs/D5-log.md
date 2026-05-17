# D5 完整复盘（2026-05-17）

> V0.8 → V0.9 · 25 commit · P1~P24 · 全天迭代驱动 = 川哥真机反馈 + 截图诊断 + Team 模式 cc/codex/gemini 协同

## 目标演化

D5 起手是"buffer 收尾"，但川哥真机试玩后涌出 24 轮微调需求，主线变成：

1. **字幕 + TTS 同步系统**（从无到精确）
2. **专注流程闭环**（进度条 + 切图 + 宝箱手动触发 + 返舱跳关）
3. **debug 工具链**（场景编号 + 下一步按钮 + state overlay）

最终 V0.9 demo 节奏被川哥手感校准到位。

## 时间线与决策

| Phase | Commit | 核心改动 | 触发 |
|---|---|---|---|
| **字幕条统一阶段** | | | |
| P1 | 0e2c84384 | StatusBar 视觉统一胶囊 + marquee | 川哥审美对齐 |
| P2 | a9e8172e2 | 字幕迁到 StatusBar 层（z-90）| 字幕在 mask 后看不到 |
| P3 | a89a4165c | **修字幕全消失：删 scene cleanup setSubtitle('')** | 真机实测全 scene 字幕丢失 |
| P4 | 729c1696e | 字幕磨砂方块贴底 + 自动消失 + NightReport 信封弹窗 | Team 模式 4 视觉规范 |
| P4.1 | 4618b91ae | NightReport z-index → modal 补提 | 上轮 Edit 失败 |
| **D5 中段：取消自动推进 + 集中 TTS** | | | |
| P5 | fc948dbb1 | 取消 demo autoTimer + NightReport 去信封壳 + 字幕 50% | 川哥 4 改 |
| P6 | c8efe2a16 | 字幕纵向滚动 + 夜航宝箱 PNG 化 + 随机 1-4 + 返舱字幕 TTS | Team 模式 4 改 |
| **P7 字幕/TTS 集中化里程碑** | f1892e27c | applyEffects 默认非空字幕 → sayDirect；删 5 处 scene-level sayDirect；App mount prewarm ws | "字幕出现都要小可说" + 首次按住卡顿 |
| P8 | 530b81c63 | jump-to-scene 字幕完整版 + 进度条按时间 + 询问统一 + 宝箱说完 buffer | 跳关 TTS 截断、宝箱切倒计时太快 |
| **debug 工具** | | | |
| P9 | fd97c9084 | K1 右侧"下一步"按钮 + 左下场景编号徽章 | 川哥要排错支持 |
| **专注切图 + 进度条系列** | | | |
| P10 | f21631b3e | 默认 stage 时长 2→4s + useStageCrossfade 初始 fade in + debug overlay | 切换太快 + 背景没图 |
| **P11 真根因** | dfc0a303a | **useStageCrossfade useEffect cleanup 取消 raf/timer 死锁 + LAUNCH_ANIM_MS 2500→4500** | 截图救命 |
| P12 | 78d0a58bf | 飞船 02 停 4s（LAUNCH_ANIM_MS 4500→8500）+ 进度条对齐美术槽 + 层级下沉 | 仍偏快 + 进度条遮按钮 |
| **P13/P14 cqh 陷阱** | 4588d2bd6 + 9d4355a41 | screen-canvas 加 containerType → 字幕缩小副作用 → 撤回 + 进度条改用 % | 进度条对齐 → 字幕缩小 → 还原 |
| **返舱 + 继续 + 随机宝箱** | | | |
| P15 | 4bac11b81 | EXIT_CONFIRM/ASK_PICK return 跳 welcome | 返舱回欢迎 |
| P16 | 328640841 | ASK_PICK continue 跳 focusRunning + dispatchRandomBox effect | 继续出航 + 宝箱随机 |
| P17 | 3191948ad | LAUNCH 时长按 mode 区分（companion 2.5s, explore 8.5s）| 静思不陪出航拖 |
| P18 | 5fefa4bff | 继续按 focusMode 选 scene + 字幕纵向滚动恢复（cqh fallback 公式校准）| 静思继续应回静思 + 字幕滚动失效 |
| **字幕/TTS 严同步系列** | | | |
| P19 | 4a87fbeea | 字幕按 TTS sentence_break 推进 + 宝箱奖励语 buffer 800→2200ms | LLM 全文超前 TTS |
| P20 | 89e3a98d8 | 删 MainScreen 兜底 + applyEffects setSubtitle 等 onAudioStart 回调 | 中间态画面残留 + 字幕提前 TTS |
| **P21 第二根因** | 6ed49e454 | **onAudioStart fire 移到 flushMp3Buffer 内 src.start() 后 + 打字机替代 sentence_break** | mp3 chunk 到达 ≠ 真发声 |
| **P22 字幕消失对齐** | 3210d3827 | 自动消失公式 130→240ms/字 + 跨句 fade-up 替代 marquee 滚 | 字幕没说完就消失 + 打字机和向上滚冲突 |
| P23 | 508e130d9 | askReturnSubtitle effect 按 focusMode 区分"继续出航/静思" | 静思也说"继续出航"违和 |
| P24 | f90ff31bd | 进度满改手动点击"收获奖励"覆盖按钮触发宝箱 | 节奏由用户掌控 |

## 三大系统级踩坑（沉淀 memory）

### 坑 1：useEffect cleanup 取消"延迟 setState 的 raf/timer"

P11 真根因。`useStageCrossfade` 写法：
```ts
useEffect(() => {
  if (target === current) return;
  setCurrent(target);                              // 触发下次 deps 变化
  setOpacity(0);
  const raf = requestAnimationFrame(() => setOpacity(1));
  return () => cancelAnimationFrame(raf);          // ← 下次 effect 跑前 cancel
}, [target, current]);                             // current 自己 set 又依赖
```

执行：`setOpacity(0)` 后 `setCurrent` 触发 rerender → deps 变 → cleanup cancel raf → 下次 effect early return → opacity 永远 0 → 背景全黑。

**修复模式**：用 useRef 跟踪自 set 字段；deps 只放外部输入；raf/timer **不挂 cleanup**，让它们幂等 fire。

→ `memory/feedback_useeffect_cleanup_cancels_raf_timer.md`

### 坑 2：cq 单位 fallback 视觉一致性陷阱

P13/P14。给 screen-canvas 加 `containerType: 'size'` 让 cqh 从 viewport (vh) 切到真实容器值（480px）后，**所有现有 cqh 元素都按比例缩了 60%**——字幕 padding、字号 clamp 下界全跟着变小。

**修复模式**：
- 单点定位用绝对单位（px / %）相对父容器
- 全屏 containerType 上线前要全量审计 cq 元素，确认数值不缩
- "为了对齐 A 而加 containerType"会全局污染 B/C/D

### 坑 3：字幕 vs TTS 时间错位（P5→P22 反复迭代根因）

5 次反复修复，本质是"字幕的 ground truth"在哪：

| 迭代 | 字幕来源 | 问题 |
|---|---|---|
| 旧 | applyEffects setSubtitle 立即 set | TTS 几百 ms 后才发声，字幕提前 |
| P20 | setSubtitle 等 onAudioStart (tts.audio chunk 到达) | mp3 还在 350ms 防抖 buffer 里，仍提前 350ms |
| **P21** | onAudioStart 移到 **flushMp3Buffer 内 src.start() 后**（精确 AudioContext clock）| 字幕与音频零误差 ✓ |
| 旧 | LLM delta 累积全文 一次性 setSubtitle | 字幕显示整段，TTS 才念第一句 |
| P19 | 按 tts.sentence_break 跳 list[idx] | LLM 切句 ≠ TTS 切句，idx 漂 |
| **P21** | **打字机按时间推进 setSubtitle(prefix)**，5 字/秒匹配 Doubao | 视觉边播边打字 |
| 旧 | StatusBar 自动消失公式 130ms/字 | TTS 200ms/字，字幕先消失 |
| **P22** | **公式 240ms/字 + 1500ms buffer** | 字幕显示 ≥ TTS 播完 + 1s 静默 |

→ `memory/feedback_tts_streaming_sentence_break.md`、`feedback_subtitle_tts_centralize_in_effect.md`、`feedback_useeffect_cleanup_overrides_machine_subtitle.md`

## 成功模式

### 团模式 D5 实测 ROI
- **cc 主写 + gemini review**：每个里程碑 commit 前派 gemini-3 flash review，多次抓出真 bug
  - D5 P6 R3: gemini 抓 StatusBar maxHeight border-box 漏 padding
  - D5 P7 R2: gemini 抓 reward-machine OPEN_ANIM_END 漏 level → 奖励语漏 TTS
- **截图救命**：川哥发截图比口述更快定位（P10 → P11 通过截图直接看到 running·openable·61% 全黑）
- **debug overlay 必加**：D5 P10 加场景编号 + state 显示，后续川哥所有反馈都能精确定位

### 状态机 effect 抽象升级
- 引入 `askReturnSubtitle`、`dispatchRandomBox` 两个 effect，让纯函数 transition 也能"按 store 上下文动态决策"（runner 内读 store）
- 模板：transition 返简单 effect → runner 内做有状态/随机/异步操作

## 工程债与后续 TODO

### 优先级 P1（影响 demo 演示）
- [ ] 真机 D5 演练（iOS Safari HTTPS + mkcert + 字幕同步实测）
- [ ] sayDirect 路径下 onAudioStart 触发后字幕显示——需要 sayDirect 也调 `ttsSpeak(text, cb)` 而非现有 voice-client.sayDirect 直调

### 优先级 P2（视觉打磨）
- [ ] RewardClaimButton 位置/尺寸真机微调（用 left/top/width/height % 估的，截图反馈再校准）
- [ ] 进度条美术槽对齐：现在用固定 6% bottom + 88% width，不同 stage 图槽位略有差异
- [ ] focus launching 阶段字幕条 z-index 检查

### 优先级 P3（技术债）
- [ ] `useStageCrossfade` 在 D5 P11 用 ref-based 重写，但代码注释中保留了"D5 P6 R3 修正"等 stale 注释
- [ ] StatusBar 的 `scrollState` 已不用但仍有 dummy `const scrollState = { dur: 0, offset: 0 } as const`，可清理
- [ ] DebugBar 删 `focusSpeed` 已无用，但 store 字段保留为兼容，可删（grep 确认无其他消费方）
- [ ] Welcome scene 已删除内嵌字幕 / sayDirect，但 STARS 数据 + 星点 keyframes 装饰代码可保留也可外提复用

## 沉淀到 memory 的 feedback

- [feedback_useeffect_cleanup_overrides_machine_subtitle.md](../memory)（D5 P3）
- [feedback_subtitle_tts_centralize_in_effect.md](../memory)（D5 P7）
- [feedback_useeffect_cleanup_cancels_raf_timer.md](../memory)（D5 P11）
- 待补 D5 P13/14 cq 单位陷阱
- 待补 D5 P21 字幕 TTS 严同步范式（typewriter + onAudioStart at src.start）

## V0.9 真机演示流程

1. 手机 https://192.168.1.193:5173/ → 完成配网
2. 跳关 1：开机欢迎 → 字幕 + TTS 同步
3. 跳关 2：夜航报告 → 1-4 个随机宝箱 PNG + TTS 完整
4. 跳关 3：状态询问 → "今天想出航还是静思？"
5. 选出航 → 4.5s 飞船过渡 → 16s 4 阶段切图 + 进度条 → **手动点收获奖励** → 随机宝箱 → 字幕 + TTS 同步 → 询问"继续出航 还是 返舱？"
6. 选继续 → 重回出航；选返舱 → "太棒了 +10" → 回欢迎
7. 选静思 → 2.5s 单图过渡 → 同上 → 询问"继续静思 还是 返舱？"
8. F：关盖告别

debug：左下角紫色徽章实时显示场景编号 + focus 状态；K1 右侧"下一步"循环跳关。
