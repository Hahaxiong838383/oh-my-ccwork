# 03 · 状态机详细图（V0.1）

> XState v5 实现，分 4 个机器 + 1 个顶层编排。

---

## 顶层编排 (rootMachine)

```
            ┌───────────────────────┐
            │   bootMachine          │
            │   (开机/欢迎/夜航/    │
            │    开箱/解锁/状态询问)│
            └──────────┬────────────┘
                       │ ask_done(mode: explore|companion)
                       ▼
            ┌───────────────────────┐
            │   focusMachine         │
            │   (专注/暂离/二次确认)│
            └──────────┬────────────┘
                       │ exit_confirmed
                       ▼
            ┌───────────────────────┐
            │   rewardMachine        │
            │   (开箱队列/生态缸    │
            │    解锁动画)          │
            └──────────┬────────────┘
                       │ all_rewards_consumed
                       ▼
                  back to bootMachine.askMode

(voiceMachine 并行运行，监听唤醒词)
```

---

## bootMachine

```
                  [LID_OPEN]
                       │
                       ▼
                  ┌─────────┐
                  │ booting │
                  └────┬────┘
                       │ bootAnimEnd
                       ▼
                  ┌─────────┐
                  │ welcome │ ── checkOfflineHours ≥48h? 切第二套
                  └────┬────┘
                       │ welcomeEnd
                       ▼
              checkNightReportDone?
              ├ done   → skip
              └ undone ↓
                  ┌──────────────┐
                  │ nightReport  │ → 物资堆等级判定 → 基础奖励动画
                  │              │ → 额外发现判定 → 宝箱动画
                  └──────┬───────┘
                         │ nightReportDone (写云端)
                         ▼
              checkPendingBoxes?
              └ yes → ┌─────────────┐
                     │ resumeOpen  │ → reward machine
                     └──────┬──────┘
                            │ done
                            ▼
              checkPendingEcoAnims?
              └ yes → ┌─────────────┐
                     │ ecoUnlockAnim│
                     └──────┬──────┘
                            │ done
                            ▼
                  ┌─────────┐
                  │ askMode │ ── NoanswerTime 秒倒计时
                  └────┬────┘
                       │ ──┬─ user picks explore   → focusMachine(explore)
                          │
                          └─ user picks companion / timeout → focusMachine(companion)


[LID_CLOSE] 任何状态 → ┌────────────────┐
                       │ shutdownFarewell│ → 退出
                       └────────────────┘
```

**关键守卫**：
- `48hOver`：lastLid.close → now > 48h × dict.Offlinetime
- `nightReportDoneToday`：服务器 today's done flag
- `crossNewDay`：lastUse 跨过北京时间 0:00

---

## focusMachine

```
              ┌─────────────────┐
              │ confirmEntering │ ── 用户答 explore/companion 或超时
              └────────┬────────┘
                       │ start
                       ▼
                  ┌─────────┐
                  │ running │ ←──┐
                  └────┬────┘    │
                       │         │ userReturn (≤Backtime)
              presenceLost (30s) │
                       ▼         │
                  ┌─────────┐    │
                  │ paused  │ ───┘ 用户回来 → running
                  └────┬────┘
                       │ presenceLostDuration > Longleave (60min)
                       ▼
                  ┌──────────────┐
                  │ forceOffline │ → 写 last_offline_start, 退出 focus
                  └──────────────┘

[USER_EXIT_REQUEST]（点按钮或语音"结束探索"）
                       ▼
                  ┌─────────────────┐
                  │ confirmExit     │ ── 30s 超时 → 回 running
                  └────────┬────────┘
                           │ confirmed
                           ▼
                  ┌─────────────────┐
                  │ exitToReward    │ → rewardMachine
                  └─────────────────┘

[宝箱生成]（running 内每秒 tick + 查 DropTable.xlsx）
  → 增加 boxes 数组 → 触发 store 更新（UI 渐显新宝箱图标）
```

**状态内变量**：
- `focusedSeconds`：累计专注时长（秒）
- `awayStartedAt`：本次暂离开始时间
- `boxes`：本次专注已生成的宝箱列表
- `mode`：explore | companion
- `layout`：3 种随机布局之一（每次进 focus 时随机）

---

## rewardMachine

```
                  ┌─────────────────┐
                  │ checkQueue      │
                  └────────┬────────┘
                           │ has unopened boxes
                           ▼
                  ┌─────────────────┐
                  │ openingBox      │ ── 调 /api/treasure/open 拿奖励
                  └────────┬────────┘
                           │ openAnim done
                           ▼
                  ┌─────────────────┐
                  │ showingReward   │ ── 数字滚动 + 粒子飞向胶囊
                  └────────┬────────┘
                           │ rewards displayed
                           ▼
                  ┌─────────────────┐
                  │ xiaokeVoiceLine │ ── 小可读 rewardVoiceID
                  └────────┬────────┘
                           │ done
                           ▼
                      more boxes?
                      ├ yes → back to openingBox
                      └ no  ↓
                  ┌─────────────────┐
                  │ checkEcoUnlock  │ → 是否触发生态缸动画
                  └────────┬────────┘
                           │
                  ┌────────┴────────┐
                  │ ecoUnlockAnim   │ ── 渐隐小可 → 按解锁/升级顺序播放
                  └────────┬────────┘
                           │ all done
                           ▼
                          [done]
```

**中断恢复**：每个 box 开始播动画前写 Dexie `pending_open: {box_id, started_at}`。
进入 reward machine 时先检查 pending，从该 box 重头播。

---

## voiceMachine（并行运行）

```
                  ┌─────────┐
                  │ idle    │ ── 麦克风常开，检测唤醒词
                  └────┬────┘
                       │ wakeWord detected ("小可小可"/"你好小可"/"爱视可")
                       ▼
                  ┌─────────────┐
                  │ awakening   │ ── 播唤醒提示音 + 音量降至 40%
                  └────┬────────┘
                       │ done
                       ▼
                  ┌─────────────┐
                  │ listening   │ ── 录音，触发 VAD
                  └────┬────────┘
                       │ VAD ended / silence
                       ▼
                  ┌─────────────┐
                  │ parsing     │ ── STT + 意图识别
                  └────┬────────┘
                       │ command parsed
                       ▼
                  hasConfirm?
                  ├ yes ↓
                  │     ┌─────────────┐
                  │     │ confirming  │ ── 二次确认（30s 超时回 idle）
                  │     └────┬────────┘
                  │          │ confirmed
                  │          ▼
                  └ no  ┌─────────────┐
                        │ executing   │ ── 触发对应业务
                        └────┬────────┘
                             │
                             ▼
                          [idle]

[场景特殊处理]
- 夜航报告/专注/开箱 中唤醒 → 暂停游戏语音，调音量 40%
- 退出 voice → 恢复 100% 音量
```

**支持的命令**（demo 阶段）：
| 命令 | 触发 | 是否需要二次确认 |
|---|---|---|
| 开始学习/开始陪伴 | askMode | 否 |
| 结束 / 我学完了 / 结束探索 | focus | **是** |
| 开箱 / 收获奖励 | focus 内 | 否 |
| 关闭设置 / 关闭界面 | settings 打开时 | 否 |
| 给小可换装 / 换皮肤 | 任何 | 否（进换装界面） |

---

## 状态持久化

每个机器的 `currentState` 在每次 transition 后写入 Dexie：

```ts
// Dexie schema
machine_state: {
  machine_name: 'boot' | 'focus' | 'reward' | 'voice';
  state_value: string;            // XState state JSON
  context: object;                // 状态上下文
  updated_at: number;
}
```

启动时 `rootMachine` 从 Dexie hydrate，超过 24h 的状态视为过期重置。

---

## 测试策略

每个机器都要有：
- **happy path** 测试（正常通过的转换）
- **timeout 路径** 测试（NoanswerTime/30s 二次确认/暂离阈值）
- **中断恢复** 测试（kill state → 重启 → 接续）
- **守卫边界** 测试（48h 临界 / 60min 临界 / 跨日临界）

工具：`@xstate/test` + Vitest。

---

## 状态机可视化

`pnpm machine:visualize` 启动 XState Visualizer，导出 SVG 到 `docs/diagrams/`。
PR 时如果修改了机器，**必须更新对应 SVG**，保证文档和实现同步。
