# HANDOFF: 代码级自改进 Phase 1 零数据排查

> **上下文**：Admin UI 进化中心的"代码级自改进 Phase 1" 4 个条件**全部卡在 0**，从未有过任何数据产生。
> 本 session 已修复 eval 管道（让 eval 能正常跑）和 deploy.sh 数据覆盖 bug，但 **Phase 1 零数据的根本原因还未定位**。

---

## 🎯 核心问题

Admin UI 进化中心显示：

```
🚀 代码级自改进 Phase 1
0/4 条件已满足

⬜ 稳定运行天数      0天 / 14天
⬜ 动态测试用例      0条 / 30条
⬜ 置信度学习轮次    0轮 / 10轮
⬜ Eval 通过率       98% / 85%  ← 这项已满足，但页面显示不对
```

其中 3 个条件需要的数据文件在 Studio 上**从未产生过**：

| 条件 | 需要的文件 | Studio 状态 |
|------|-----------|------------|
| 稳定运行天数 | `~/mycc-brain/data/evolution-actions.jsonl` | ❌ 不存在 |
| 动态测试用例 | `~/mycc-brain/data/evolution-tests/` | ❌ 不存在 |
| 置信度学习 | `~/mycc-brain/data/diagnosis-confidence.json` | ❌ 不存在 |
| Eval 通过率 | `~/mycc-brain/eval/eval-result.json` | ✅ 存在（手动修复） |

---

## 🔍 排查路径（核心问题）

**数据流链路**：
```
eval cron (06:00)
  → eval-result.json（已通）
  → evolution cron (07:00) 触发 runDailyEvolution
  → diagnoseLatestEval → diagnosis-confidence.json
  → generateEvolutionTests → data/evolution-tests/*.jsonl
  → applyPatches → evolution-actions.jsonl
```

**猜测的断点位置**（按概率排序）：

### 🔴 最高嫌疑：evolution cron 从未成功触发或从未产生输出

brain server 的 `scheduleEvolution()` 在 `server.ts:1370-1393`，每天 07:00 触发 `runDailyEvolution()`。

**需要验证**：
1. 这个 cron 是否真的被触发过？（查 pm2 logs 看 `[evolution] daily cycle starting`）
2. 即使被触发，`runDailyEvolution()` 是否因为某个前置条件失败而直接返回？
3. 是否有 try/catch 吞掉了异常？

### 🟡 次嫌疑：diagnoseLatestEval 返回 null，后续全部跳过

`src/services/evolution-engine.ts`（或 diagnosis 相关文件）里 `diagnoseLatestEval(brainRoot)` 可能因为：
- eval-result.json 之前长期是旧数据（被 deploy.sh 覆盖的老 bug）
- 读取失败返回 null
- 整个 evolution pipeline 在第一步就退出

### 🟢 第三嫌疑：自进化的"守门"逻辑过严

MANIFESTO.md 规定的累积风险分 > 100 / 需要 pass=true 才能触发等规则，可能导致 evolution 即使跑了也不产生 actions。

---

## 📋 本 session 已完成的修复（背景上下文）

这些修复为 Phase 1 排查铺平了道路，但**没有直接解决 Phase 1 零数据**：

| 修复 | 状态 | 作用 |
|------|------|------|
| eval.ts 优雅降级（GEMINI KEY 缺失时） | ✅ 已部署 | 让 eval 不再直接 exit(1) |
| eval-report.ts avgCol 零值 bug | ✅ 已部署 | 修复 baseline 全 -100% 误报 |
| run-eval.sh 加固（set -e / env 加载） | ✅ 已同步 | 让 eval cron 能正常跑完 |
| Studio 安装 Node v22.22.2 | ✅ | eval cron 需要 node |
| Studio .env.local 补齐 ADMIN_PASS | ✅ | eval 能通过 admin 认证 |
| Studio crontab 恢复 `0 6 * * *` | ✅ | eval 每天 06:00 自动跑 |
| **deploy.sh 排除运行时数据**（长期老 bug） | ✅ **已修复未部署** | 防止 Air 旧数据覆盖 Studio 新数据 |
| Admin UI 状态点红→黄（401 时）| ✅ 已部署 | 登录过期提示更友好 |
| Admin UI eval-result.json 手动构造 | ✅ | 让用户看到新数据 |

**关键：deploy.sh 改了还没部署**（部署会覆盖刚手动修好的 eval-result.json）。下个 session 可以考虑先 commit + 等 06:00 cron 跑出真数据后再 deploy。

---

## 🛠️ 下个 Session 应该做的事

### Step 1：验证 evolution cron 是否在跑

```bash
# 查 pm2 日志里有没有 [evolution] daily cycle 启动痕迹
ssh studio-pub 'pm2 logs brain --lines 200 --nostream 2>&1 | grep -i evolution'

# 查 server.ts 启动日志确认 scheduleEvolution() 被调用
ssh studio-pub 'pm2 logs brain --lines 50 --nostream 2>&1 | grep -E "Cron|schedule"'
```

### Step 2：看 evolution-engine 的代码路径

```
/Users/rayman.chen/mycc/2-Projects/brain-product/mycc-brain/src/services/evolution-engine.ts
/Users/rayman.chen/mycc/2-Projects/brain-product/mycc-brain/src/services/evolution-test-gen.ts
/Users/rayman.chen/mycc/2-Projects/brain-product/mycc-brain/src/server.ts  # 1370-1393 行 scheduleEvolution
```

重点看 `runDailyEvolution()`：
- 哪一步是数据生成的起点？
- 有没有"静默 return"的分支？
- diagnoseLatestEval 返回 null 时的处理？
- 有没有守门条件（比如 pass 必须 true 才跑 evolution）？

### Step 3：手动触发一次 evolution

```bash
# 绕过 cron，直接在 Studio 上触发 runDailyEvolution
ssh studio-pub 'cd ~/mycc-brain && node -e "
import(\"./dist/services/evolution-engine.js\").then(m => m.runDailyEvolution(process.cwd()))
  .then(r => console.log(\"result:\", JSON.stringify(r, null, 2)))
  .catch(e => console.error(\"err:\", e));
"'
```

如果这能产生 evolution-actions.jsonl / evolution-tests/ / diagnosis-confidence.json，那说明：**cron 从未被触发**或**cron 每次都被某个前置条件卡住**。

### Step 4：如果 runDailyEvolution 跑不出数据

用 Codex 对抗审查，分析为什么数据生成逻辑不工作。关键问题：
- 数据生成的**最小触发条件**是什么？
- 是不是需要先有多次 eval 历史才能触发？
- 是不是 confidence 需要人工初始化？

### Step 5：验证 Admin UI Eval 通过率显示

用户截图显示 "Eval 通过率 98% / 85%" ✅ 已满足 —— 这项条件其实是达到了，但页面渲染可能有 bug。
检查 `admin-ui.html` line 1212-1239 的 phase1-readiness 渲染逻辑，看是否正确显示"已满足"状态。

---

## 📂 关键文件速查

### 后端（数据生成）
```
src/server.ts:829-887         # Admin API: /admin/api/evolution/phase1-readiness
src/server.ts:1370-1393       # scheduleEvolution() 07:00 定时器
src/services/evolution-engine.ts   # runDailyEvolution / diagnoseLatestEval / revertAction
src/services/evolution-test-gen.ts # loadEvolutionTestCases
src/eval/eval.ts              # eval 入口
src/eval/eval-report.ts       # writeEvalResult / checkRegressions
```

### 前端（UI 渲染）
```
src/admin/admin-ui.html:461   # ePhase1Card 卡片
src/admin/admin-ui.html:1212  # phase1-readiness fetch 和渲染逻辑
```

### 运行时数据（Studio）
```
~/mycc-brain/data/evolution-actions.jsonl      # ❌ 不存在（条件1）
~/mycc-brain/data/evolution-tests/             # ❌ 不存在（条件2）
~/mycc-brain/data/diagnosis-confidence.json    # ❌ 不存在（条件3）
~/mycc-brain/eval/eval-result.json             # ✅ 存在（条件4 已满足）
~/mycc-brain/data/evolution-log.jsonl          # evolution cron 写这里
```

### 部署脚本
```
deploy.sh                     # ⚠️ 改了未部署，部署前先备份 Studio eval-result.json
scripts/run-eval.sh           # eval cron 入口
```

---

## 🎬 可粘贴 Prompt（下个 Session 开场）

```
继续排查 mycc-brain 的"代码级自改进 Phase 1 零数据"问题。

先读：
1. /Users/rayman.chen/mycc/2-Projects/brain-product/HANDOFF-phase1-zero.md
2. /Users/rayman.chen/mycc/2-Projects/brain-product/MANIFESTO.md（Phase 1 定义）
3. /Users/rayman.chen/mycc/2-Projects/brain-product/mycc-brain/src/services/evolution-engine.ts（数据生成入口）
4. /Users/rayman.chen/mycc/2-Projects/brain-product/mycc-brain/src/server.ts 的 scheduleEvolution（1370-1393 行）

核心问题：Admin UI 显示 Phase 1 的 4 个条件全是 0/N，但这些条件对应的数据文件
（evolution-actions.jsonl / evolution-tests/ / diagnosis-confidence.json）在 Studio 上
从未产生过。背景是上个 session 已修复了 eval 管道和 deploy.sh 数据覆盖 bug，
所以 eval-result.json 现在是正常的（条件4已满足），剩下 3 个条件需要从 evolution
pipeline 产生数据。

任务：
1. 验证 Studio 上的 evolution cron (每天 07:00) 是否真的在跑
   - 查 pm2 日志: `ssh studio-pub 'pm2 logs brain --lines 300 --nostream 2>&1 | grep -i evolution'`
2. 读 evolution-engine.ts 的 runDailyEvolution 函数，找出"数据从未产生"的断点
3. 手动在 Studio 触发一次 runDailyEvolution，看能否产生数据：
   `ssh studio-pub 'cd ~/mycc-brain && node -e "..."'`（具体命令见 HANDOFF 第 Step 3）
4. 如果卡住，启动 agent team + Codex 对抗审查，深入分析数据生成逻辑
5. 解决后：验证 Admin UI 进化中心的 Phase 1 条件是否开始有数据

约束：
- /effort max，agent team 并行
- 每次 deploy.sh 前必须先备份 Studio 上 eval-result.json（防止再次覆盖）
- 下一次 eval cron 跑在明天 06:00，期间不要手动跑 deploy.sh

/brain-review 先跑一次再开始
```

---

## ⚠️ 重要提醒

1. **deploy.sh 已改未部署** —— 部署会触发 rsync，虽然新版排除了 eval/，但首次部署前最好先备份 Studio 的 eval-result.json 和 data/ 关键文件
2. **不要在 06:00 cron 跑完前跑 deploy.sh** —— 否则会干扰 cron 产出
3. **Phase 1 Eval 通过率其实已满足**（98% > 85%），但页面显示 ⬜ 未勾选 —— 这是 UI 渲染 bug 还是数据判断 bug 需要单独排查
4. **Codex 插件用法注意**：直接用 `codex:rescue` subagent 有时会卡在 "Thread ready" 不实际做事，建议用 Bash 直接调用 codex CLI 或者用 Agent tool 的 general-purpose subagent + 明确的代码修改指令

---

**创建时间**：2026-04-10
**创建者**：cc（Claude claude-opus-4-6）
**上一个 Session 的核心产出**：
- 修复 eval 全链路（node 安装 / env 配置 / cron 恢复 / 代码优雅降级）
- 修复 deploy.sh 数据覆盖老 bug（未部署）
- run-eval.sh 全面加固
- Admin UI 状态点红黄区分
