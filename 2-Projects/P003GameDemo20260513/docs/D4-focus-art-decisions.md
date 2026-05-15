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
| P3 过渡 | ✅ done | TBD（本 commit） | 2026-05-15 14:20 |
| P4 交接 | ⏸ pending | — | — |

## 9. P2 验收摘要

- **Codex**：3 个文件改动（新建 useStageCrossfade hook + 2 scene 加 CSS keyframe）
- **CC**：build/scope-check PASS，e2e 七段 PASS（0 errors）
- **Gemini Review**：5/5 PASS, APPROVE

## 10. P3 验收摘要

- **Codex**：5 个文件改动（FocusRunning launching 双图层 + FocusCompanion 简化 + useFocusArtPreload + Screen 接入 + DebugBar 演示按钮）
- **CC 发现并修复 typo**：codex 写的 `08-near-full.png` 实际磁盘是 `08-handoff.png`，cc 手修
- **CC**：build/scope-check PASS，e2e 七段 PASS
- **Gemini Review**：6/6 PASS, APPROVE + 3 个好评观察（80ms linear 平滑过渡 / 1700ms 切换姿态锁定 / Companion 静思简化合理）
