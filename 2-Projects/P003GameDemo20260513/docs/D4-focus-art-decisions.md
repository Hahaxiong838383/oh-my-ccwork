# D4 · focusRunning / focusCompanion 美术化决策记录

> 决策日期：2026-05-15
> 川哥拍板，cc 实施，team 模式（codex 写码 + gemini 审查）。
> 这次改动较大，每 Phase 一个独立 commit，便于 `git revert <hash>` 回滚。

## 1. 回滚锚点

| 锚点 | Commit | 说明 |
|---|---|---|
| **美术化之前的 baseline** | `b18cb5a1` | chore(P003): 加 playwright + e2e 脚本接 aria-label。focusRunning 还没有专属视觉，只是底部按钮变化。 |

回滚到 baseline：`git reset --hard b18cb5a1`（**慎用**，会丢所有美术化改动）
单 Phase 撤销：`git revert <phase-commit>`（推荐，保留历史）

## 2. 川哥拍板的决策点

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| D1 | 静思模式资源 | `/Users/rayman.chen/Documents/P003 Game demo/UI界面/静思模式/` 4 张 PNG | 川哥指定路径 |
| D2 | 出航模式资源 | `/Users/rayman.chen/Documents/P003 Game demo/UI界面/出航模式/` 8 张 PNG | 同上 |
| D3 | DebugBar 加速度滑块 | 是 | demo 现场调节"几秒走完"，必须 |
| D4 | DebugBar 加 progress 起点输入框 | 是 | 跳关测试不同阶段 |
| D5 | 定时器驱动 | 用户打开 web 起算，按秒推进，乘速度滑块 | 不绑设备/真信号，纯 web 时长 |
| D6 | 提交粒度 | 每 Phase 一个 commit | 便于回滚 |

## 3. 改动范围预估

### 新增

| 文件 | 用途 |
|---|---|
| `apps/web/src/scenes/FocusRunning.tsx` | 出航场景主组件 |
| `apps/web/src/scenes/FocusCompanion.tsx` | 静思场景主组件（结构对称） |
| `apps/web/public/art/focus-running/` | 8 张出航 PNG |
| `apps/web/public/art/focus-companion/` | 4 张静思 PNG |
| `apps/web/src/hooks/useFocusProgressTick.ts` | 定时器 hook |

### 修改

| 文件 | 改动 |
|---|---|
| `apps/web/src/store/app-store.ts` | 加 `focusProgress / focusStage / focusStartedAt / focusSpeed` 字段 + setter |
| `apps/web/src/machines/focus-machine.ts` | 加 `FOCUS_PROGRESS_TICK / FOCUS_PROGRESS_SET / FOCUS_REWARD_READY` event |
| `apps/web/src/screen/Screen.tsx` | 按 focusMachine state 路由到 FocusRunning/FocusCompanion |
| `apps/web/src/device/DebugBar.tsx` | 速度滑块 + progress 起点输入框 |
| `apps/web/src/machines/jump-to-scene.ts` | jumpToScene 到 focusRunning/focusCompanion 时设置初始 stage |

## 4. Phase 划分（每 Phase 一个 commit）

| Phase | 内容 | 验收 | 估时 |
|---|---|---|---|
| **P1 基建** | store 字段 + Screen 路由 + FocusRunning/Companion 单图占位 + DebugBar 速度滑块 + progress 起点输入框 | 跳关到 focusRunning 看到 1 张"锁"图，DebugBar 滑块可调速度，输入框可设起点 | 2-2.5h |
| **P2 4 阶段切换 + 动效** | 接 8/4 PNG 切换 + 旋转环 30°/s + 锁微震 + 宝箱发光脉动 + 定时器 hook tick | progress 0→100 走完 4 阶段，60fps 不掉帧 | 2h |
| **P3 launching 过渡** | 出航专注1 + 出航过渡 PNG + 预加载 + sayDirect TTS | AskMode 选出航 → 完整 2.5s 启航 → 进入 running | 1.5h |
| **P4 reward 交接** | 满进度 dispatch FOCUS_REWARD_READY + 闪白 300ms + reward-machine 接管 | 端到端：出航 → 进度积累 → 开箱 → familyCoin +10 | 1.5h |

**总计 ~7.5h**。每 Phase 完成后 cc 跑 build/scope/e2e + gemini review，通过才进下一 Phase。

## 5. 数据契约（最终版）

### Zustand store 新增字段

```ts
focusProgress: number       // 0-100
focusStage: 'locked' | 'active' | 'openable' | 'full'  // 派生
focusStartedAt: number      // Date.now() 启航 timestamp
focusSpeed: number          // 速度倍数，默认 1.0，DebugBar 滑块控制
focusMode: 'explore' | 'companion'  // 已存在，复用
```

### Stage 阈值

| Stage | progress 范围 | 出航 PNG | 静思 PNG |
|---|---|---|---|
| locked | 0–25 | 出航宝箱-锁.png | 主界面-礼物宝箱(1) 9.png |
| active | 25–60 | 出航宝箱-进度条2.png | 主界面-礼物宝箱(1) 8.png |
| openable | 60–95 | 专注2-积累进度.png | 主界面-礼物宝箱(1) 5.png |
| full | 95–100 | 专注3-获得宝箱.png | 主界面-礼物宝箱(1) 6.png |

### 定时器规则（D5 拍板）

- 启航成功（launching → running）时 `focusStartedAt = Date.now()`
- hook `useFocusProgressTick` 每 1s 计算：
  `progress = min(100, (Date.now() - focusStartedAt) / 1000 * focusSpeed * BASE_RATE)`
- `BASE_RATE = 1.0`（每秒 +1%，60s 满）；`focusSpeed × 10` 可 6s 走完
- DebugBar 起点输入框：直接 set `focusStartedAt = Date.now() - (起点% / BASE_RATE / focusSpeed * 1000)`

## 6. 风险清单（每 Phase 前回看）

| 风险 | 缓解 |
|---|---|
| 资源 ~3.5MB 首屏阻塞 | launching 阶段预加载，运行时图懒加载 |
| jumpToScene 跳关时 focusStartedAt 错乱 | jumpToScene 入口统一重置 focusStartedAt = Date.now() |
| confirmExit 时 PNG 不应回退 | focusStage 在 confirmExit 阶段冻结，不重计算 |
| Welcome → AskMode → FocusRunning 链路其他 scene 受影响 | 每 Phase 跑完整 e2e（11 场景 + 11 键 + C2 状态机） |
| reward-machine 接管时 focusMachine 状态不一致 | P4 加 paused 状态过渡，避免双机抢 UI |

## 7. 进度记录

| Phase | 状态 | Commit | 完成时间 |
|---|---|---|---|
| P0 决策记录 | ✅ done | c07959cfd | 2026-05-15 13:10 |
| P1 基建 | ✅ done | TBD（本 commit） | 2026-05-15 14:02 |

## 8. P1 验收摘要

- **Codex**：9 个文件改动一次性产出，build/scope-check 双门 PASS
- **CC E2E**：完整跑 A/B/C/C2/C3/C4/D 七段，21 transitions / 50 SFX / 0 errors / 0 404s，截图 `b-focusRunning.png` 和 `b-focusCompanion.png` 美术真正渲染（出航 4 锁宝箱 + 静思 4 礼物宝箱）
- **CC 视觉确认**：DebugBar 速度滑块 + 进度输入框只在 focus 场景显示，welcome/askMode 等场景不污染
- **Gemini Review**：10/10 PASS，0 concerns，APPROVE
- **冗余备注**：FOCUS_PROGRESS_TICK event + tickFocusProgress effect 是按 prompt 加的，但 hook 实际选择直接调 setter，event 路径目前 dead code。P4 reward-machine 交接时可能用上，先保留
| P2 动效 | ✅ done | a47049124 | 2026-05-15 14:12 |
| P3 过渡 | ✅ done | 9f207bd6e | 2026-05-15 14:20 |
| P4 交接 | ✅ done | abc5bd389 | 2026-05-15 14:42 |
| P5 字幕修复 | ✅ done | b8806fa16 | 2026-05-15 17:22 |
| P6 静思图替换 | ✅ done | 33f693771 | 2026-05-16 13:38 |
| P7 出航图替换 | ✅ done | 906128ead | 2026-05-16 13:58 |
| P8 宝箱 PNG | ✅ done | cc0f09a88 | 2026-05-16 14:18 |
| P9 生态缸 mp4 | ✅ done | TBD（本 commit） | 2026-05-16 15:58 |

## 17. P9 生态缸 mp4 动态升级演示

**川哥决策**：源路径 `/Users/rayman.chen/Documents/P003 Game demo/UI界面/生态缸/生态缸动态/` 4 个 mp4 共 6.8MB。

**实施**（codex 写 + gemini APPROVE）：
- `apps/web/public/art/eco/1.mp4 ~ 4.mp4`（数字命名延续川哥风格）
- store 加 `EcoLevel = 1|2|3|4` + `ecoLevel: EcoLevel = 1` + setter
- EcoUnlock.tsx：原圆框 emoji 🐟 → `<video key={ecoLevel} src="/art/eco/${ecoLevel}.mp4" autoPlay loop muted playsInline preload="auto" object-cover>`，外层保留 cyan border + gradient 水缸玻璃效果。标题从硬编码 "Lv2" 改为动态 `Lv${ecoLevel}`。reducedMotion 路径也用动态文字 + 跳过 video（无障碍）
- DebugBar：4 个等级按钮 [🌱 Lv1] [🌿 Lv2] [🌳 Lv3] [✨ Lv4]，仅 `focusMachine === 'idle' && rewardMachine === 'idle'` 时显示

**验收**：
- check:scope + build PASS
- E2E 七段（含 C4 eco 段）PASS, 0 errors, 0 404s
- P9 mini E2E（`scripts/p9-eco-levels-test.mjs`）4 等级切换 PASS：截图证据 `.scratch/p9-screenshots/eco-lv1.png ~ eco-lv4.png`，4 个视频视觉各异（Lv1 室内 → Lv2 雪景 → Lv3 太空舱 → Lv4 多元素）
- Gemini Review 8/8 PASS APPROVE 0 concerns
- iOS Safari 自动播放硬要求（muted + playsInline）全齐

## 16. P8 宝箱视觉从 emoji 升级到 PNG（川哥指定新素材）

**川哥决策**：源路径 `/Users/rayman.chen/Documents/P003 Game demo/UI界面/宝箱/` 共 4 张宝箱 PNG。

**关键发现**：原先 OpenBox.tsx 用 emoji `📦` + 彩色光环渲染宝箱，川哥这次给的不是替换 PNG（之前没有），而是**首次加入 PNG 美术**。

**实施**：
1. cp 4 张到 `apps/web/public/art/box/`，规范命名为 `1-common.png / 2-rare.png / 3-epic.png / 4-legendary.png`（数字 + 等级英文，避免中文 URL encoding）
2. `boxes.ts`：BoxConfig 接口加 `imageSrc: string`，4 等级补对应 PNG 路径
3. `OpenBox.tsx`：把 `<motion.span>📦</motion.span>` 改为 `<motion.div><img src={config.imageSrc} ...></motion.div>`，width/height 替代 fontSize，保留 motion animate / filter drop-shadow / 入退场动画

**衍生修复**：legendary 圆环原来 scale 3.5×+brightness 1.5（emoji 时代 gemini 评审建议"爆金"），切换到不透明 img 后金色染色把宝箱完全遮住 → 撤销 legendary 特殊化（统一 1.95×、去 brightness），同时给宝箱 `motion.div` 加 `z-10` 保险层级。

**验收**：
- check:scope + build PASS
- E2E 七段 PASS，0 errors，0 404s
- 4 等级 e2e 截图：rare/epic/legendary 宝箱清晰可见（蓝/橙/深蓝水晶各色）。common 在 t1 时段被 c3 SettingsTip 残留挤压时序，疑似边角时序问题（jumpToScene 间隔短），川哥真机演示如有异常会再调

## 15. P7 出航图替换（川哥指定 7 张新素材）

**川哥决策**：源路径 `/Users/rayman.chen/Documents/P003 Game demo/UI界面/出航模式/` 共 7 张新图。

**映射策略**：**按视觉用途**（不是文件名数字 1-7 严格对应），保证代码 launching/transition/locked/active/active-rotating/openable/full 各 stage 视觉链路正确。

| 新文件 | → 落盘 | 用途 | 视觉 |
|---|---|---|---|
| 出航2.png | 01-launching.png | launching 主图 | 近景小可飞船舱 + "出航"霓虹大字 |
| 出航1.png | 02-transition.png | launching→running 过渡 | 远景缩略小可 + 螺旋星空 |
| 出航3.png | 03-locked.png | locked | 4 锁宝箱 + 灰按钮 |
| 出航4.png | 04-active.png | active 第 2 圈 | 金色旋转环 |
| 出航5.png | 05-active-rotating.png | active 伪旋转环辅助 | 第 3 圈中间宝箱形状（灰）|
| 出航6.png | 06-openable.png | openable | 中间宝箱蓝色光晕 |
| 出航7.png | 07-full.png | full | x2 宝箱 + 橙色"收获奖励"按钮 |
| —（不替换）| 08-handoff.png | rewarding state 静止图 | 旧版保留（新源未提供对应）|

**老 8 张备份**：`/tmp/focus-running-old/`（不进库）。
**FocusRunning.tsx 代码零修改**（文件名不变所以映射 STAGE_IMAGE_MAP 不动）。
**潜在体验风险**：04 (第 2 圈) 和 05 (第 3 圈) 视觉位置不同，做伪旋转环 crossfade 可能"穿帮"。先上让川哥真机看，必要时关闭 alternateEnabled 或重做映射。
**验收**：check:scope + build + e2e + p5 subtitle test 全 PASS，0 errors。

## 14. P6 静思图重制（川哥指定新素材）

**川哥决策**：源路径 `/Users/rayman.chen/Documents/P003 Game demo/UI界面/静思模式/` 下的 4 张已重制，要求按文件名顺序替换。

**新 4 张映射**：
| stage | 文件名 | 视觉 |
|---|---|---|
| locked | 静思1.png | 4 锁宝箱 + 进度条低 + 小可坐椅子读书（暖光室内）|
| active | 静思2-进度条满.png | 4 锁宝箱 + 进度条满 + "收获奖励"按钮亮 |
| openable | 静思3-获得宝箱.png | 左上礼物变 x28 宝物 + 橙色"收获奖励"按钮 |
| full | 静思4 -获得更多宝箱.png | 4 礼物全开 x28 + 全部领完 |

**实施**：cp 覆盖 `apps/web/public/art/focus-companion/01-04.png`，文件名不变（不动 FocusCompanion.tsx 代码）。
**老 4 张备份**：`/tmp/focus-companion-old/`（不进库）。
**验收**：check:scope + build + e2e 七段 + p5 subtitle test 全 PASS，0 errors，截图证据 `.scratch/e2e-screenshots/b-focusCompanion.png`。

## 13. P5 验收摘要

- **Codex**：2 文件改动（Screen.tsx Fragment 包 + MainScreen 删除内部 StatusBar）
- **Gemini Review R1**：5/5 R1-R5+TS PASS，R6 **CONCERN** — z-layer-feedback (50) < z-layer-mask (70) 会被 OpenBox/Welcome 遮挡
- **CC 修衍生缺陷**：tailwind.config.js `layer-feedback` 50 → 75（高于 mask 70，低于 modal 80）
- **Gemini Review R2**：3/3 PASS，APPROVE
- **CC 验证**：写 `apps/web/scripts/p5-subtitle-test.mjs` mini E2E，注入 subtitle 截图 focusRunning/focusCompanion 两个 scene，字幕条**真显示** ✅
- **Welcome 截图字幕不显示**：是 Welcome 自渲染字幕（不依赖 StatusBar），不在 P5 范围，技术债存档

## 12. P5 任务（字幕跨场景修复）

**问题**：P1 路由分流后 FocusRunning/FocusCompanion 没渲染 StatusBar 组件，字幕条消失。

**决策**：StatusBar 从 MainScreen 提升到 Screen.tsx 层级，所有 scene 共享。

**改动文件**：
- `apps/web/src/screen/Screen.tsx`：Fragment 包 scene + StatusBar（ShutdownScreen 不带）
- `apps/web/src/components/MainScreen.tsx`：删除内部 StatusBar import + JSX

**回滚锚点**：P5 失败 → `git revert <P5 commit>`，回到 abc5bd389（功能不变，字幕仍缺失）。

## 11. P4 验收摘要

- **Codex**：8 个文件改动（store + types + focus-machine + machines/index + hook + 2 scene + DebugBar）
- **rewarding state 完整闭环**：running → rewarding (FOCUS_REWARD_READY) → idle (REWARD_FLOW_DONE)
- **边沿检测**：useFocusProgressTick 用 `rewardLeftIdleRef + rewardDoneSentRef` 跟踪 reward 离开 idle 后回 'idle' 或 'done'，避免误触发
- **CC P4 mini E2E**：写了 `apps/web/scripts/p4-reward-handoff-test.mjs`，模拟一键满进度 → 整套链路 → 最终 focus.idle / reward.done。**PASS**（0 errors, favicon 404 已过滤）
- **截图证据**：`.scratch/p4-screenshots/`，02-after-quick-full 出航场景 + OpenBox overlay 显示，05-final-state 已回 MainScreen
- **Gemini Review**：8/8 PASS, APPROVE, 0 concerns

## 9. P2 验收摘要

- **Codex**：3 个文件改动（新建 useStageCrossfade hook + 2 scene 加 CSS keyframe）
- **CC**：build/scope-check PASS，e2e 七段 PASS（0 errors）
- **Gemini Review**：5/5 PASS, APPROVE

## 10. P3 验收摘要

- **Codex**：5 个文件改动（FocusRunning launching 双图层 + FocusCompanion 简化 + useFocusArtPreload + Screen 接入 + DebugBar 演示按钮）
- **CC 发现并修复 typo**：codex 写的 `08-near-full.png` 实际磁盘是 `08-handoff.png`，cc 手修
- **CC**：build/scope-check PASS，e2e 七段 PASS
- **Gemini Review**：6/6 PASS, APPROVE + 3 个好评观察（80ms linear 平滑过渡 / 1700ms 切换姿态锁定 / Companion 静思简化合理）
