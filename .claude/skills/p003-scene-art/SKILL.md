---
name: p003-scene-art
description: P003 K1 demo 场景美术化标准方法论：把抽象 CSS 占位场景替换为静态写实 PNG + 3 轻动效（星点漂移 / 表情屏绿光呼吸 / 字幕暖光晕）+ TTS sayDirect 开口，与状态机解耦零侵入。触发词："/p003-scene-art"、"把 XX 场景换成美术"、"P003 场景美术化"、"按 Welcome 风格做 YY 场景"、"用美术资源替换 ZZ"
---

# P003 场景美术化 Skill · V1.2 (D5 update)

> 2026-05-14 D3.5 V1.0 → D5 2026-05-17 V1.2 实战补充
>
> **V1.2 新增**：
> - 字幕/TTS 严同步范式（见 `feedback_subtitle_tts_strict_sync_pattern.md`）
> - 状态机 effect 抽象（dispatchRandomBox / askReturnSubtitle）
> - debug 工具最小集（SceneNumberBadge + NextStepButton）
> - 美术槽位 overlay 模式（RewardClaimButton 透明按钮覆盖背景图按钮）
> - 反模式：containerType 全局副作用 / useEffect cleanup 取消延迟 setState

## 适用场景

> **边界**：本 Skill 只负责 P003 K1 demo 的栅格场景美术与前端轻动效；P003 CMF、包装、镭雕、蚀刻、铭牌等 `.ai`/SVG/PDF 矢量图纸检查与文字转曲修改，统一使用 `vector-artwork-editing` Skill，避免把制造图纸流程混入场景美术。

P003 K1 demo (`/Users/rayman.chen/mycc/2-Projects/P003GameDemo20260513/`) 内任何一个 boot scene / reward scene / focus scene 需要从"抽象 CSS 占位"升级为"静态写实 PNG + 轻动效 + 真实 TTS 开口"。

**已实施**：SetupGuide / Welcome / AskMode（boot）
**待实施**：NightReport / OpenBox 4 级 / EcoUnlock / Farewell / focusRunning

## 核心思路（4 条铁律）

1. **状态机零侵入**：不改 boot-machine / focus-machine / reward-machine / jumpToScene。只换视图层 PNG + 透明 hit area，事件链完全保留。
2. **PNG 自包含 UI 元素**：按钮文案 / 字幕 / 装饰图案都烧进 PNG。代码只渲染必要的动效叠加层 + 透明 hit area。**减少代码与图的耦合**。
3. **3 轻动效黄金组合**（gemini 立场 B + codex 立场 C 综合）：
   - 舷窗外星点漂移（5-6 颗，clipPath 限制在舷窗形状内防穿帮）
   - 表情屏绿光呼吸（绿色径向渐变 + mix-blend-mode screen + iOS Safari @supports 降级）
   - 字幕进场淡入 + 暖白光晕呼吸（场景配色统一暖色调）
4. **TTS sayDirect 开口**：场景 mount 后 useEffect 立即 sayDirect，与字幕进场动画重叠。AudioContext 解锁由 SetupGuide 完成配网按钮 onClick 提前完成（用户手势栈内 unlockAudio）。

## 7 步实施流程

### Step 1 · 资产准备（川哥负责）

约定路径：`apps/web/public/assets/<scene>-bg.png`

| 场景 | 文件名 |
|---|---|
| 配网 | `setup-bg.png` + `setup-success.mp4`（过渡视频）|
| 欢迎 | `welcome-bg.png` |
| 询问 | `askmode-bg.png` |
| （新场景） | `<scene>-bg.png` 命名 |

要求：800×480 PNG（与画布尺寸对齐，object-cover 自动 cover），含场景全部 UI 元素（按钮/装饰/文字）。

⚠️ **macOS Finder 双 .png 后缀陷阱**：川哥用 Finder 保存常有 `welcome-bg.png.png` 问题，cc 收到后必检 + `mv` 重命名。

### Step 2 · 读图测量坐标（cc 负责）

用 Read tool 直接读 PNG，肉眼测量以下区域（800×480 画布坐标 → 转 cqw/cqh）：

| 测量目标 | 用途 |
|---|---|
| 小可表情屏中心 + 尺寸 | 绿光呼吸 div 的 left/top/width/height |
| 舷窗范围 | 星点 clipPath ellipse 参数 |
| 按钮位置（如有）| 透明 hit area 的 left/top/width/height |

cqw/cqh 换算：`x_cqw = x_pixel / 800 × 100`，`y_cqh = y_pixel / 480 × 100`。

### Step 3 · 套模板 + 替换参数

参考 `examples/template-scene.tsx`，把以下 6 个参数替换：

| 参数 | 例 |
|---|---|
| `SCENE_BG` | `'/assets/<scene>-bg.png'` |
| `SCENE_LINE` | TTS 开口文案，如 `'指挥官，今天想出航，还是静思呢？'` |
| `STARS` 配置 | 星点位置（仅放舷窗范围内）|
| `clipPath` 椭圆 | 舷窗形状 |
| 表情屏绿光 left/top/width/height | 测量值 |
| Hit areas（如有按钮）| 测量值 + 派发对应事件 |

### Step 4 · 状态机集成（保持事件链）

只在视图层里调 `dispatchBoot` / `dispatchFocus` / `dispatchReward`，不改任何 machine 文件：

```tsx
// 例：AskMode 选择
const onPickLeft = useCallback(() => {
  dispatchBoot({ type: 'ASK_MODE_PICK', mode: 'explore' });
  dispatchFocus({ type: 'LAUNCH', mode: 'explore' });
}, [dispatchBoot, dispatchFocus]);
```

### Step 5 · TTS 集成

每个场景统一 useEffect 模板：

```tsx
const spokenRef = useRef(false);
useEffect(() => {
  if (!isActive) {
    spokenRef.current = false;
    return;
  }
  if (spokenRef.current) return;
  spokenRef.current = true;
  const client = getSharedVoiceClient();
  void (async () => {
    try {
      await client.connect(getVoiceWsUrl());
    } catch (err) {
      console.warn('[<scene>] voice ws connect failed', err);
      return;
    }
    client.sayDirect(SCENE_LINE);
  })();
}, [isActive]);
```

注意：
- `isActive` 是该场景的 boolean（如 `bootState === 'welcome'`），用作 useEffect dependency
- `spokenRef` 防止 StrictMode 双触发 + 同场景重入时重复 TTS
- `getVoiceWsUrl()` 复制到每个 scene 文件（utility 函数，未来可提到 shared）

### Step 6 · AudioContext 解锁

⚠️ iOS Safari 强约束：`AudioContext.resume()` 必须在**用户手势同步栈内**调用。

P003 唯一入口：DebugBar `✅ 完成配网` onClick handler 内**立即** `client.unlockAudio()`。后续所有自动播 TTS 路径都借此 resume。

如果新场景的入口不经过完成配网按钮，需要：
- 在该场景入口的按钮 onClick 内加 unlockAudio
- 或在 App 顶层加一次性 touchstart/click listener

详见：`~/.claude/projects/-Users-rayman-chen-mycc/memory/feedback_audio_context_user_gesture_chain.md`

### Step 7 · 验证

```bash
# tsc check
cd apps/web && npx tsc --noEmit | grep -iE "error|<scene>"

# 静态资产 200
curl -sk -o /dev/null -w "HTTP %{http_code}\n" "https://localhost:5173/assets/<scene>-bg.png"

# 川哥手机刷新 + 跳关到该场景 + 听 TTS + 按钮点测
```

如果 hit area 不精准（点不到按钮 / 边界差几个 pixel）：用 playwright probe 拿 getBoundingClientRect 实测，比肉眼快 10x。

## 3 个已实施案例索引

| 场景 | 关键参数 | 代码 |
|---|---|---|
| SetupGuide | 视频过渡 + 字幕条注释 + DebugBar 触发 | [examples/setup.md](examples/setup.md) |
| Welcome | 6 颗星点 / 表情屏 (46cqw,36cqh) / 字幕暖白光晕 | [examples/welcome.md](examples/welcome.md) |
| AskMode | 5 颗左舷窗星点 / 表情屏 (47cqw,28cqh) / 双 hit area + 倒计时小圆环 | [examples/askmode.md](examples/askmode.md) |

完整模板：[template-scene.tsx](template-scene.tsx)

## 常见参数对照表

### 星点动效（4s 短窗口下能感知的下限）

```
drift: 3-4cqw（横向位移 24-32px）
duration: 3.0-3.8s（4s 窗口内能完成 1 个完整周期）
opacity: 0.25 → 1.0（差值要大，不然看不见）
scale: 0.65 → 1.25（同上）
delay: -0.4 ~ -3.0s 负延迟错开相位
数量: 5-6 颗（不能更多，过密像噪声）
boxShadow: 0 0 5px rgba(255,255,255,0.85)
```

### 表情屏绿光呼吸

```
位置: 测图取小可表情屏中心
尺寸: 14-18cqw × 11-13cqh
background: radial-gradient(ellipse at center, rgba(110,255,170,0.85) 0%, rgba(110,255,170,0.3) 40%, transparent 70%)
filter: blur(2.2-2.4cqh)
duration: 1.8s
opacity: 0.25 → 0.85
scale: 0.9 → 1.12
mix-blend-mode: screen + @supports not 降级
父层 isolation: isolate（防止 iOS Safari 染色）
```

### 字幕条（仅 Welcome 用，其它场景 PNG 自带文案则跳过）

```
位置: bottom 6cqh / 居中
样式: rounded-full bg-black/40 backdrop-blur-md / 内边距 5cqw × 1.6cqh
字号: clamp(12px, 3.4cqw, 18px)
进场: 0.8s ease-out fade + translateY(8px → 0)
光晕呼吸: 2.6s 周期 / text-shadow 暖白 rgba(255,240,210)
```

## 不推荐的反模式（gemini 反复警告）

- ❌ 整图呼吸缩放（scale 1→1.02 8s）→ 800×480 小画布会看到边缘锯齿"晕车感"
- ❌ 高频粒子 / 闪烁（周期 <1s）→ 焦躁感，破坏治愈基调
- ❌ 高饱和度色彩闪烁 → 必须保持原图漫反射柔光高级色相
- ❌ 字幕用冷蓝光晕配暖色场景（黄沙发/粉花/绿表情屏）→ 显"脏蓝"，必须暖白
- ❌ 没 isolation 父层就用 mix-blend-mode → iOS Safari 整图被染绿
- ❌ 星点不用 clipPath 裁到舷窗 → drift 后跑到舱壁穿帮
- ❌ 周期 6s+ 但 4s 窗口下完成不到半周期 → 动效无效

## 与 codex / gemini 团队协作模式

派 codex 写新 scene 代码时 prompt 必带：

```
- 不改 boot-machine / focus-machine / reward-machine / jumpToScene
- 不改 voice-client（除非新增公共方法，否则严禁动 onmessage / playAudioChunk）
- 不改 server pipeline（除非新增 message type，必须同时改 server/src/index.ts 的 decodeClientMessage 白名单）
- 输出 ## Summary 含改动行号 + 任何潜在风险
```

派 gemini 视觉品味审：先描述图内容 + 列动效候选 + 问 A/B/C 立场。

派 codex 对抗审查：列 P1/P2/P3 分级，要求至少 2 个改进建议（不许只夸）。

## 迭代历史

- **V1.0**（2026-05-14 23:00）：D3.5 沉淀，3 场景实施完成（SetupGuide / Welcome / AskMode）
- **V2.0**（2026-05-16）：D4 focus 美术化 + 视频升级，13 commit 完整 Phase（P0~P9.7）
- V2.x：每次新场景实施完，更新 [iteration-log.md](iteration-log.md) 记录新经验

## V2.0 增量（focus 多阶段 + 视频升级 + 跨场景共享 UI）

V1.0 只覆盖单一静态 PNG boot scene。D4 引入了 focus 多 stage / mp4 视频 / 跨 scene 共享 UI 几类新场景，方法论补充：

### N1. 多阶段 stage 切换（focus 类场景）

适用：focusRunning / focusCompanion / 任何"进度推进+视觉演变"场景

**模式**：
- store 加 `xxxProgress: 0-100` + `xxxStage: 'A'|'B'|'C'|'D'` + `xxxStartedAt: timestamp` + `xxxSpeed: 0.5-20`
- hook `useXxxProgressTick`：监听 startedAt + speed，1s setInterval 推 progress，progress ≥ 100 触发 state machine event
- scene `<XxxRunning />`：按 stage 切 PNG，用 `useStageCrossfade(stage, imageMap, options)` hook 做 300ms opacity crossfade（避免硬切闪烁）
- 可选 `alternateSrc + alternateIntervalMs` 实现伪旋转环（两张同主题图 1.5s 切换）
- CSS @keyframes 4 stage 动效（不依赖图内元素坐标，只对整张图 transform/filter）：
  - locked: rotate ±1.5° 微震 4s 周期
  - active: scale 1→1.005→1 缓慢呼吸 2.5s
  - openable: scale 1→1.025→1 + brightness 1→1.08 召唤 1.4s
  - full: scale 1→1.04→1 + brightness 1→1.15 强召唤 1s

### N2. launching 双图层过渡

适用：state machine 进 launching state（如 `idle → launching → running`）的"启航"过渡视觉

**模式**：
- launching 子组件用 `useState elapsedMs + setInterval 16ms` 跟踪自身进度（不依赖 state machine timer）
- 0~主图持续时间：显示启航主图 + CSS enter 动画（scale 1.05→1, opacity 0→1）+ 浮动 keyframe
- 后半段过渡：crossfade 到过渡帧 PNG，opacity 1→0 / 0→1 + scale 1.05→1.0 + filter blur 4→0px
- 总时长**严格对齐 state machine** LAUNCH_ANIM_MS（如 2500ms）避免 React rerender 慢一拍

### N3. 资源预加载 hook

```ts
// hooks/useXxxArtPreload.ts
useEffect(() => {
  if (mode === null) return;
  for (const src of artSources[mode]) {
    const img = new Image(); img.src = src;
  }
}, [mode]);
```

调用点：Screen.tsx 顶层。new Image() 不阻塞主线程，浏览器自动缓存。

### N4. state machine 桥接其他 machine（rewarding state）

适用：xxx state machine 满进度自动触发 reward / open / 其他 machine 接管

**模式**：
- xxx-machine 加 `rewarding` state + `XXX_REWARD_READY / REWARD_FLOW_DONE` event
- 在 effect runner 加新 effect type `dispatchRewardEvent`（同步派发其他 machine event）
- progress hook 检测 `progress >= 100` 一次性 dispatch `XXX_REWARD_READY`（用 `ref` 防重）
- rewarding 退出条件：边沿检测 `rewardLeftIdleRef + rewardDoneSentRef` 双 ref 跟踪 reward machine 离开 idle 再回到 `idle | done` 时 dispatch `REWARD_FLOW_DONE`
- ⚠️ **重要**：reward machine 完成后可能停在 `done` 而不是 `idle`，必须同时检测两个终态

### N5. mp4 视频集成

适用：动态升级演示、循环背景、解锁动画

**模式**：
- 资源放 `public/art/<topic>/<level>.mp4`，按数字命名（避免中文 URL encoding）
- `<video key={level} src="/art/.../{level}.mp4" autoPlay loop playsInline preload="auto" className="absolute inset-0 h-full w-full object-cover object-center">`
- `key={level}` 强制 remount 重播切换等级
- 默认不写 muted（带声播放）+ `onCanPlay` 兜底：
  ```tsx
  onCanPlay={(e) => {
    void e.currentTarget.play().catch(() => {
      e.currentTarget.muted = true;
      void e.currentTarget.play().catch(() => {});
    });
  }}
  ```
  iOS Safari 拦截 unmuted autoplay 时退回 muted 重试，避免"完全不播"死锁
- 全屏铺满 800×480：`object-cover + object-center` 宽度顶满，长度方向超出自动裁切
- 顶部叠暗色 gradient mask 增强标题可读：`background: linear-gradient(rgba(4,8,20,0.78) → 0)`，高度 22%

### N6. 跨场景共享 UI（Screen 路由分流必查）

**坑**：当 Screen.tsx 加路由分流到新 scene（替代 MainScreen），原本在 MainScreen 内的共享组件（StatusBar / WizardOfOz / etc）会**完全消失**。

**修复**：把共享 UI 提到 Screen.tsx 层级用 Fragment 包：

```tsx
if (!lidOpen) return <ShutdownScreen />;
const scene = ...; // 路由选 FocusRunning / FocusCompanion / MainScreen
return <>{scene}<StatusBar /></>;
```

**z-index 审计**：共享 UI 的 z-layer 必须高于覆盖 mask（OpenBox / Welcome z-70），低于 modal（z-80）。当前推荐 `z-layer-feedback: 75`。

### N7. 资源类型切换的视觉栈冲突预警

emoji `📦` → img PNG 类型切换暴露老逻辑 bug：
- emoji 是字符渲染，filter brightness 1.5 / drop-shadow 都在字外部生效，不影响字本身
- 不透明 img 是矩形位图，filter brightness 1.5 整张图过曝 + scale 3.5 圆环把图染色遮死

**铁律**：切换素材类型时**重审整个视觉栈**——filter / blend-mode / scale 在新素材下的行为可能完全不同。必看截图，不要只信 build PASS。

### N8. 资源命名规范

| 类别 | 命名 |
|---|---|
| 场景背景 PNG | `<scene>-bg.png`（V1.0） |
| 多阶段 PNG | `01-stageA.png ~ NN-stageN.png`（数字 + 英文等级，无 URL encoding 风险） |
| 视频 mp4 | `1.mp4 ~ N.mp4`（纯数字简洁） |
| 临时用川哥源名 | 拷贝时改名，源文件留 `/Users/rayman.chen/Documents/` 不动 |

### N9. DebugBar 演示控件模式

每个新场景类型应该在 DebugBar 提供"现场切换"控件，仅在该场景活跃时显示（条件渲染避免污染其他流程）：

| 场景类型 | DebugBar 控件 |
|---|---|
| focus 多阶段 | 速度滑块 0.5-20× / 进度起点输入框 / 一键满进度 / 演示过渡按钮 |
| 多等级视频 | N 个等级按钮 [Lv1] [Lv2] ... 高亮当前 |

显示条件：`focusMachine === 'idle' && (rewardMachine === 'idle' || rewardMachine === 'specific-state')`，让相关流程中也可见但其他流程隐藏。

## 触发协议

cc 收到任何形如以下任务时主动按本 skill 执行：
- "把 XX 场景换成 PNG 美术"
- "按 Welcome 风格做 YY 场景"
- "把 ZZ 改成 D3.5 风格"
- "用美术资源替换 ZZ"
- "把 XX 场景加 mp4 动态升级演示"（V2.0 新增）

收到 PNG 文件后自动：
1. 检查双扩展名 + 重命名
2. Read PNG 测坐标
3. 套模板 + 状态机集成 + TTS 集成
4. tsc check + curl 资产
5. commit + push（如果川哥让上推）

## D5 V1.2 补充：4 个工程范式（必读）

### 范式 A：字幕 + TTS 严同步（3 个对齐点）
- **出现**：字幕等 voice-client `flushMp3Buffer` 内 `src.start()` 之后才显示（用 AudioContext clock 精确对齐，非 tts.audio chunk 到达）。在 `ttsSpeak(text, onAudioStart)` 内 set 字幕
- **推进**：打字机按时间字速 5 字/秒（匹配 Doubao 平均）推 setSubtitle(currentSentence.slice(0, charsByElapsedTime))
- **消失**：StatusBar 自动消失公式 `text.length × 240ms + 1500ms buffer`，clamp [3500, 12000]
- 详见 `feedback_subtitle_tts_strict_sync_pattern.md`

### 范式 B：状态机 effect 抽象（让纯函数也能"按 context 动态决策"）
- transition 返简单 effect (`'dispatchRandomBox'` / `'askReturnSubtitle'`)
- applyEffects 内读 store 决定具体行为（随机宝箱品质 / 按 focusMode 拼字幕）
- 保持 transition 纯函数同时支持动态

### 范式 C：debug 工具最小集（demo 期必加）
- `SceneNumberBadge` 左下紫色徽章（场景编号 + focus state overlay）
- `NextStepButton` K1 右侧"下一步"按钮（SCENE_ORDER 循环跳关）
- `deriveCurrentScene(store)` 反推当前 SceneId（统一推导）
- **交付前一行删除组件调用即清理**

### 范式 D：美术槽位 overlay 模式
- 美术 PNG 里画好"按钮"的视觉（如"收获奖励"）
- React 端透明 `<button>` 用 % 定位精确覆盖美术按钮（`left: 50% top: 74% width: 38% height: 15%`）
- z-layer-ui-focus (45) 在背景上方
- 优点：美术控视觉 + React 控交互，零图标资源 + 易动态显隐

## D5 反模式（必避）

### 反模式 1：useEffect cleanup 取消"延迟 setState 的 raf/timer"
deps 含被自己 set 的 state → cleanup 取消 raf → setOpacity 永远卡 0 → 画面全黑
（D5 P11 useStageCrossfade 死锁，背景全黑）

### 反模式 2：containerType 全局副作用
为对齐单点元素加 `containerType: 'size'` → 所有 cqh fallback 元素从 vh 切到真容器值 → 全部按比例缩
（D5 P13 加 containerType → P14 撤回 + 改用 %）

## 关联记忆

- [feedback_codex_protocol_whitelist_gate.md](../../../projects/-Users-rayman-chen-mycc/memory/feedback_codex_protocol_whitelist_gate.md)
- [feedback_audio_context_user_gesture_chain.md](../../../projects/-Users-rayman-chen-mycc/memory/feedback_audio_context_user_gesture_chain.md)
- [feedback_voice_client_internal_dispatch.md](../../../projects/-Users-rayman-chen-mycc/memory/feedback_voice_client_internal_dispatch.md)
- [feedback_subtitle_tts_centralize_in_effect.md](../../../projects/-Users-rayman-chen-mycc/memory/feedback_subtitle_tts_centralize_in_effect.md) — D5 P7
- [feedback_useeffect_cleanup_cancels_raf_timer.md](../../../projects/-Users-rayman-chen-mycc/memory/feedback_useeffect_cleanup_cancels_raf_timer.md) — D5 P11
- [feedback_cq_unit_fallback_pitfall.md](../../../projects/-Users-rayman-chen-mycc/memory/feedback_cq_unit_fallback_pitfall.md) — D5 P13/P14
- [feedback_subtitle_tts_strict_sync_pattern.md](../../../projects/-Users-rayman-chen-mycc/memory/feedback_subtitle_tts_strict_sync_pattern.md) — D5 P20-P22
- [project_p003_k1_demo.md](../../../projects/-Users-rayman-chen-mycc/memory/project_p003_k1_demo.md)
