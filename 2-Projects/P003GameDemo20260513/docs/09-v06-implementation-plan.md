# 09 · V0.6 实施计划（D2-D5 · 评审整合版）

> 起草时间：2026-05-14 10:00
> 输入：[08-v05-implementation-plan.md](./08-v05-implementation-plan.md)（V0.5 原版） + codex 工程评审 + gemini 产品评审
> 川哥拍板：**A 方案 4.5 天，不砍 demo 效果**

---

## 一、与 V0.5 的差异

### 1.1 demo 效果保留

- ✅ SettingsPanel 完整 4 项 UI 交互（点齿轮 + 顶部下拉双入口）
- ✅ 键盘 0-9 全量快捷键 + 跳关下拉条双轨
- ✅ AskMode 双文案差异化（开机 / 结算）
- ✅ 4 级宝箱代码全做（视频用 1 普 + 1 传反差）

### 1.2 工程加固（codex 评审）

- Event 联合类型 + effect 返回值 + dev warn 非法 transition
- ScreenOverlayHost：所有画内 Modal 用 absolute 挂在屏幕根，禁 fixed/portal
- jumpToScene 原子函数 + 10 个 hydratePreset（每个 preset 含 stardust/familyCoin/wifi/voiceStatus/subtitle 初值）
- data-scope="screen-canvas" 标记 + check-scope-boundary.mjs 静态扫描
- 首次保证 4 级宝箱改"保证队列 + sessionStorage"（替代 Set 方案）
- 烟花粒子 80 → 32 + prefers-reduced-motion 降级
- iOS 后台节流处理（页面 visibilitychange 暂停 timer）
- 音频 buffer 释放（barge-in 后立刻 revokeObjectURL）

### 1.3 演示节奏（gemini 评审）

- 视频脚本：AI 语音从 52s 前置到 5s
- 4 级宝箱演示从"4 级连开"改为"1 普 + 1 传反差"
- 配网+WiFi 切换 15s → 3s 一带而过
- 小可"思考中"音效 + 眨眼动效掩盖 AI 延迟
- 设置面板 2s 旁白带过

### 1.4 锦上添花（demo 完成后才做）

- 手机陀螺仪视差（D5 buffer 可做可不做）
- 小可摸头反馈（D5 buffer 可做可不做）

---

## 二、工时分配（4.5 天 / 39.5h）

| 时段 | 任务 | 工时 | 关键风险 |
|---|---|---|---|
| **D2 上午** | 状态机 3 机器（Event 联合 + effect + dev warn）+ ScreenOverlayHost + data-scope 静态检查 + DebugBar（配网/WiFi/跳关）+ CoinHud 校正 + WifiHud 4 档 + SetupGuide 场景 + CountdownRing | 5.5h | 状态机改动大但范围可控 |
| **D2 下午** | AI 语音三段集成（火山主线 / 兜底链）+ Hono WebSocket + voice-client.ts + AudioWorklet PCM16 + barge-in。**16:00 硬止损**：未达 3 项指标立刻切短轮询 + **小可"思考中"音效占位** | 8.5h | **D2 最大风险** |
| **D3 上午** | Welcome + NightReport + AskMode（双文案）+ jumpToScene + 10 个 hydratePreset + 小可眨眼 | 5.0h | 倒计时复用，难度低 |
| **D3 下午** | OpenBox 4 级差异化（粒子 32 + reduced-motion 降级）+ 保证队列算法 + EcoUnlock + Farewell + 跳关 4 级精准触发 | 6.0h | 动画工时偏紧 |
| **D4 上午** | 部署 VPS + HTTPS + 手机扫码真机测试 + iOS Safari 音频解锁 + iOS 后台节流处理 + 音频 buffer 释放 | 5.0h | iOS Safari 兼容性 |
| **D4 下午** | SettingsPanel 完整 4 项交互（齿轮 + 顶部下拉手势）+ 录 90s demo 视频 + 3 条兜底脚本 | 5.5h | — |
| **D5 上午 buffer** | 兼容性修复 + 文档收尾 + commit/push + 锦上添花 2 项可选 | 4.0h | — |
| **合计** | | **39.5h** | |

---

## 三、状态机接口契约

### 3.1 三个机器

```ts
// machines/types.ts
export type BootState =
  | 'unconfigured' | 'welcome' | 'nightReport' | 'askMode' | 'running';

export type BootEvent =
  | { type: 'SETUP_DONE' }
  | { type: 'SETUP_RESET' }
  | { type: 'BOOT_ANIM_END' }
  | { type: 'WELCOME_END' }
  | { type: 'NIGHT_REPORT_DONE' }
  | { type: 'ASK_MODE_TIMEOUT' }
  | { type: 'ASK_MODE_PICK'; mode: 'explore' | 'companion' }
  | { type: 'JUMP_TO_SCENE'; scene: SceneId };

export type FocusMachineState =
  | 'idle' | 'launching' | 'running' | 'paused' | 'confirmExit';

export type FocusEvent =
  | { type: 'LAUNCH' }
  | { type: 'LAUNCH_ANIM_END' }
  | { type: 'PRESENCE_LOST' }
  | { type: 'PRESENCE_BACK' }
  | { type: 'EXIT_REQUEST' }
  | { type: 'EXIT_CONFIRM' }
  | { type: 'EXIT_CANCEL' }
  | { type: 'EXIT_TIMEOUT' };

export type RewardMachineState =
  | 'idle' | 'openingBox' | 'showingReward' | 'ecoUnlock' | 'askMode' | 'done';

export type RewardEvent =
  | { type: 'OPEN_BOX'; level: BoxLevel }
  | { type: 'OPEN_ANIM_END' }
  | { type: 'REWARD_SHOWN' }
  | { type: 'ECO_CHECK' }
  | { type: 'ECO_DONE' }
  | { type: 'ASK_PICK'; choice: 'continue' | 'return' };
```

### 3.2 transition function 签名

```ts
export interface TransitionResult<S> {
  state: S;
  effects: Effect[];
}

export type Effect =
  | { type: 'startTimer'; key: string; ms: number }
  | { type: 'clearTimer'; key: string }
  | { type: 'playSfx'; id: string }
  | { type: 'setVoiceStatus'; status: VoiceStatus }
  | { type: 'setSubtitle'; text: string }
  | { type: 'addStardust'; amount: number }
  | { type: 'addFamilyCoin'; amount: number }
  | { type: 'setXiaokeEmotion'; emotion: XiaokeEmotion };

export function bootTransition(
  current: BootState,
  event: BootEvent,
): TransitionResult<BootState>;

export function focusTransition(
  current: FocusMachineState,
  event: FocusEvent,
): TransitionResult<FocusMachineState>;

export function rewardTransition(
  current: RewardMachineState,
  event: RewardEvent,
): TransitionResult<RewardMachineState>;
```

### 3.3 dev 模式非法事件 warn

```ts
function warnInvalid<S, E>(machine: string, state: S, event: E): void {
  if (import.meta.env.DEV) {
    console.warn(`[${machine}] invalid event`, { state, event });
  }
}
```

非法 transition 时调用，保留 `state` 不变。

---

## 四、组件文件结构

```
apps/web/src/
├── components/
│   ├── CoinHud.tsx              [改] $家族币(金) 在前 + ☆星尘(紫) 在后
│   ├── WifiHud.tsx              [新] WiFi 4 档状态图标
│   ├── SettingsButton.tsx       [新] 齿轮按钮（独立组件）
│   ├── SettingsPanel.tsx        [新·D4] 完整 4 项 UI 交互
│   ├── ScreenOverlayHost.tsx    [新] 画内 Modal 挂载点
│   ├── CountdownRing.tsx        [新] 通用 30s 倒计时环
│   ├── XiaokeBlink.tsx          [新·D3] 小可眨眼动效包装
│   ├── StatusBar.tsx            (保持)
│   ├── Xiaoke.tsx               (保持)
│   ├── EcoBackground.tsx        (保持)
│   ├── VoiceButton.tsx          (保持，外壳里)
│   ├── Tips.tsx                 (保持)
│   ├── ConfirmModal.tsx         (保持)
│   ├── NewbieHalo.tsx           (保持)
│   ├── FocusToggle.tsx          [删·D3] 拆成 askMode 按钮 + 退出按钮
│   ├── MainScreen.tsx           [改] 整合所有 HUD + 场景路由
│   ├── WizardOfOz.tsx           [改·D3] 改键盘后门 + 跳关下拉绑定
│   └── ShutdownScreen.tsx       [改·D3] 接到 farewell 场景
├── scenes/                      [新·D3] 7 个剧情场景
│   ├── SetupGuide.tsx           # D2 配网引导
│   ├── Welcome.tsx              # 开机欢迎
│   ├── NightReport.tsx          # 夜航报告
│   ├── AskMode.tsx              # 状态询问（双文案）
│   ├── OpenBox.tsx              # 开宝箱（4 级差异化）
│   ├── EcoUnlock.tsx            # 生态缸升级
│   └── Farewell.tsx             # 关盖告别
├── machines/                    [新] 手写状态机
│   ├── types.ts                 # 三机器 State/Event/Effect 类型
│   ├── boot-machine.ts
│   ├── focus-machine.ts
│   ├── reward-machine.ts
│   ├── jump-to-scene.ts         # 跳关原子函数 + 10 个 hydratePreset
│   └── index.ts                 # 顶层编排 + effect runner
├── hooks/
│   ├── useCountdown.ts          [新] 通用倒计时（自动暂停 on visibilitychange）
│   └── useTransitionRunner.ts   [新] 状态机 + effect runner 集成
├── device/
│   ├── DeviceFrame.tsx          [改] 加 data-scope + 调试区
│   └── DebugBar.tsx             [新] 配网/WiFi/跳关 3 控件
├── config/
│   ├── boxes.ts                 [新] 4 级宝箱配置 + 保证队列算法
│   └── demo-data.ts             [新] 全局 demo 写死常量
├── scripts/
│   └── check-scope-boundary.mjs [新] 画内/画外静态检查
└── store/
    └── app-store.ts             [已改] 加 wifi/settings/openedBoxLevels/机器状态
```

---

## 五、画内 / 画外铁律（V0.5 已定，V0.6 加自动化）

### 5.1 静态检查脚本

`apps/web/scripts/check-scope-boundary.mjs`：扫描 JSX AST，禁止以下组件出现在 `data-scope="screen-canvas"` 子树内：

```js
const FORBIDDEN_IN_CANVAS = [
  'DebugBar',
  'VoiceButton',
  'PowerButton',
  'LEDIndicator',
  'MicrophoneVent',
];
```

`pnpm prebuild` hook 自动跑，违反 = build fail。

### 5.2 屏幕根标记

`DeviceFrame.tsx:31` 已加 `data-scope="screen-canvas"`。

---

## 六、demo 视频脚本（90s · Gemini 版）

```
0:00-0:05  极速开机 + 小可挥手 + "你好指挥官" TTS
0:05-0:35  ★★★ 核心 AI 对话 30s（4 轮，含小可"思考中"占位音效）
0:35-0:45  专注模式进入 + 夜航报告快速带过（10s）
0:45-1:00  1 普通宝箱（"嗯常规收获"）+ 1 传说宝箱（震屏+金光+尖叫）反差
1:00-1:10  生态缸升级（灯光鱼缸 Lv2）
1:10-1:18  设置面板 2s 旁白带过 + 配网图标特写带过
1:18-1:30  关盖告别 + 小可挥手 + Slogan
```

AI 语音占视频 33% **且在前 35s 注意力窗口内**。

---

## 七、风险登记表（持续更新）

| 风险 | 评级 | 处置 |
|---|---|---|
| 火山 ASR/豆包/TTS v3 权限未开通 | HIGH | D2 上午同步催川哥；D2 下午 16:00 硬止损切兜底链 |
| iOS Safari 音频策略 user gesture 锁 | HIGH | D4 上午专题处理：VoiceButton 第一次按下时解锁 AudioContext |
| iOS 后台节流定时器漂移 | HIGH | useCountdown hook 监听 visibilitychange，回前台重新校准 |
| 语音并发内存泄漏 | HIGH | barge-in 后立刻 revokeObjectURL + audioElement.src = '' |
| 旋转根坐标系下 Modal 错位 | MED | 所有画内 Modal 经 ScreenOverlayHost，禁 fixed/portal |
| 传说烟花被 overflow 裁切 | LOW | overflow 期间临时 visible，动画结束恢复 hidden |
| 麦克风权限二次拒绝无引导 | MED | D4 加 "请到设置允许麦克风" Tips |

---

## 八、收尾确认（已对齐）

- ✅ A 方案 4.5 天 39.5h
- ✅ Gemini 视频脚本（AI 语音前置到 5s）
- ✅ 必做：小可"思考中"音效 + 眨眼
- ✅ 低优先级：陀螺仪视差 + 摸头反馈（demo 完成后做）

---

署名：cc（Claude）| 2026-05-14 10:00
