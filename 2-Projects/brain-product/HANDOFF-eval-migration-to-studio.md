# HANDOFF: eval 迁移到 Studio + SSOT 架构重构

> **决策已确定**：方案 B — eval 从 Mini 迁到 Studio，Studio 成为所有运行时数据的 SSOT。
> **执行方式**：下个 session 用 agent team 并行执行
> **创建时间**：2026-04-10 12:20 CST

---

## 🎯 为什么做这次迁移

### 根因回顾
- **历史架构**：eval 在 Mini，通过 `scripts/sync-data.sh` 每 15 分钟 `rsync -az` 把 Mini 的 eval-result.json 推到 Studio
- **Bug**：Mini 的 eval cron 因 env 缺失（GEMINI_PROXY_KEY / ADMIN_PASS）而失败，写旧/错数据，每 15 分钟覆盖 Studio 的正确版本
- **血泪**：本 session 在 Studio 手动修 eval-result.json 5 次都被 Mini 的 sync-data.sh 在 15 分钟内覆盖回去

### 新架构原则：Studio SSOT
> **Studio 是所有 brain 运行时数据的 Single Source of Truth**
>
> Air/Mini 产生的需要被 brain 消费的数据，通过 **事件上报（API POST）** 推送给 Studio，由 Studio 决定是否合并。**禁止任何机器通过文件级 rsync 覆盖 Studio 的运行时数据。**

**三条铁律**：
1. brain 运行时数据的写入权只属于 Studio 本地进程（eval.ts / brain server / cron scripts）
2. Air/Mini 向 Studio 推数据必须通过 API 事件，不允许文件级 rsync 覆盖
3. 部署同步（deploy.sh）只传输代码和模板，绝不动运行时数据目录

---

## 📋 执行清单

### Phase 1 — 停止错误同步（必须做）

- [ ] **1.1** 删除 Mini crontab 的 eval 条目（避免 Mini 继续每天 06:00 跑失败的 eval）
  ```bash
  ssh mini-pub 'crontab -l | grep -v "run-eval.sh" | crontab -'
  ssh mini-pub 'crontab -l'  # 验证
  ```

- [ ] **1.2** 精简 Air 上的 `scripts/sync-data.sh`（已部分完成，只停了 eval-result.json）
  - ✅ 保留：`0-System/` 同步（Air/Mini 记忆给 brain 查询用）
  - ✅ 保留：`claude-memory/` 同步
  - ❌ 删除：`evolution-log.jsonl` 单向覆盖（这是 Mini 上 eval cron 的输出，迁移到 Studio 后不需要）
  - ❌ 已删除：`eval-result.json` 单向覆盖（本 session 已完成）
  - 部署到 Mini：`rsync -az scripts/sync-data.sh mini-pub:~/mycc/2-Projects/brain-product/mycc-brain/scripts/`

- [ ] **1.3** 检查 Air 本身有没有 crontab/launchd 反向同步到 Studio（应为空）
  ```bash
  crontab -l | grep -iE "mycc-brain|eval|rsync.*studio"
  launchctl list | grep -i brain
  ```

### Phase 2 — Studio 端就位（部分已完成）

- [x] **2.1** Node.js v22.22.2 已装
- [x] **2.2** `~/mycc-brain/.env.local` 已有 GEMINI_PROXY_KEY + ADMIN_PASS
- [x] **2.3** `~/mycc-brain/scripts/run-eval.sh` 已同步（Codex 加固版）
- [x] **2.4** Studio crontab 已有 `0 6 * * * run-eval.sh`
- [ ] **2.5** **验证**：手动在 Studio 跑一次 eval
  ```bash
  ssh studio-pub 'cd ~/mycc-brain && nohup bash scripts/run-eval.sh > /tmp/eval-run.log 2>&1 &'
  # 30-40 分钟后查看
  ssh studio-pub 'tail -20 ~/mycc-brain/data/eval-stderr.log && cat ~/mycc-brain/eval/eval-result.json | head -10'
  ```
- [ ] **2.6** 验证 eval-result.json 不再被外部覆盖（观察 15-30 分钟，inode 不变）
  ```bash
  ssh studio-pub 'stat ~/mycc-brain/eval/eval-result.json' # 记录 inode
  sleep 900  # 等 15 分钟
  ssh studio-pub 'stat ~/mycc-brain/eval/eval-result.json' # 对比 inode
  ```

### Phase 3 — 架构规范化

- [ ] **3.1** 创建 `docs/architecture-ssot.md`
- [ ] **3.2** MANIFESTO.md 第十节追加 "Studio SSOT" 条款
- [ ] **3.3**（可选，长期）给 brain server 加 `/admin/api/events/report` POST 端点，接收 Air/Mini 的事件
- [ ] **3.4** 更新 `deploy.sh` 的注释，说明为什么 `data/` 和 `eval/` 被排除

### Phase 4 — Air/Mini 数据整合到 Studio（用户新要求）

用户指令：**"mini 和 air 通过过去的数据和记忆，应该被 studio 接收后，统一整合处理，而不是直接覆盖"**

#### 关键洞察
经过检查，**大部分 Air 的记忆数据已经通过 sync-data.sh 同步到 Studio 的 `mycc-data/` 目录**（注意不是 `mycc-brain/`）：

| 数据 | 路径（Studio） | 状态 |
|------|---------------|------|
| 0-System 记忆 | `~/mycc-data/0-System/` | ✅ 每 15 分钟 rsync |
| claude memory | `~/mycc-data/claude-memory/` | ✅ 每 15 分钟 rsync |

所以"整合"任务主要是**让 brain 服务显式消费这些数据**，而不是再做一次同步。

#### 建议
- **短期**：保持 `mycc-data/` 现有同步（只读数据，Studio 只读不写），brain 可文件系统访问
- **中期**：给 brain 加 `/admin/api/events/report` 端点，让 Air/Mini POST 重要事件（部署完成、skill 创建、任务失败）
- **长期**：事件溯源（event sourcing），Air/Mini 发事件，Studio 的"整合器"决定如何写入 SSOT

---

## 🤖 Agent Team 分工（下个 session 并行）

| Agent | 任务 | 文件/操作范围 | 并发安全 |
|-------|------|--------------|---------|
| **Agent-1 (Mini 清理)** | 删 Mini crontab + 部署精简的 sync-data.sh | Mini SSH + Air 本地 `scripts/sync-data.sh` | ✅ |
| **Agent-2 (Studio 验证)** | 手动跑 Studio eval + 验证不被覆盖 | Studio SSH | ✅（不同机） |
| **Agent-3 (架构文档)** | 写 `docs/architecture-ssot.md` + 更新 MANIFESTO.md | Air 本地 `docs/` 和 `2-Projects/brain-product/MANIFESTO.md` | ✅ |
| **Agent-4 (Codex 对抗审查)** | 审查方案 B 整体计划的漏洞 | 只读 | ✅ |
| **Agent-5 (Phase 1 零数据排查)** | 见 `HANDOFF-phase1-zero.md` | Studio SSH + 读 evolution-engine.ts | ⚠️ 与 Agent-2 共享 Studio，串行跑 |

---

## 🎬 下个 Session 可粘贴 Prompt

```
接手 mycc-brain 的 eval 架构迁移（方案 B：Mini → Studio）+ Phase 1 零数据排查任务。

## 必读（按顺序）
1. /Users/rayman.chen/mycc/2-Projects/brain-product/HANDOFF-eval-migration-to-studio.md
   — 本次主任务 HANDOFF，包含完整 Phase 1-4 清单和 Agent 分工
2. /Users/rayman.chen/mycc/2-Projects/brain-product/HANDOFF-phase1-zero.md
   — 附带任务：Phase 1 代码级自改进零数据排查
3. /Users/rayman.chen/mycc/2-Projects/brain-product/MANIFESTO.md
   — brain 项目纲领
4. /Users/rayman.chen/mycc/2-Projects/brain-product/mycc-brain/scripts/sync-data.sh
   — 已改（eval-result.json 同步已注释），待部署到 Mini
5. /Users/rayman.chen/mycc/2-Projects/brain-product/mycc-brain/deploy.sh
   — 已改（排除运行时数据）未部署

## 核心原则（必须遵守）
**Studio SSOT 三铁律**：
1. brain 运行时数据的写入权只属于 Studio 本地进程
2. Air/Mini 向 Studio 推数据必须通过 API，禁止文件级 rsync 覆盖
3. deploy.sh 只同步代码/模板，绝不动 data/ 和 eval/

## 任务拆分（agent team 并行）

**Agent-1（Mini 清理）**：
- SSH 到 mini-pub，删除 crontab 中 run-eval.sh 那一行（保留其他 cron）
- rsync 本 session 已改好的 scripts/sync-data.sh 到 Mini
- 在 sync-data.sh 里再删除 evolution-log.jsonl 的同步块（保留 0-System 和 claude-memory）
- 验证 Mini crontab 和 sync-data.sh 的状态

**Agent-2（Studio 验证）**：
- SSH 到 studio-pub
- 用 nohup 在 Studio 跑一次 `bash ~/mycc-brain/scripts/run-eval.sh`（30-40 分钟）
- 验证 eval-result.json 被成功写入（inode 变化 + timestamp 是今天的）
- 等 15 分钟后再次验证 inode 不变（确认 Mini 的 sync 不再覆盖）

**Agent-3（架构文档）**：
- 写 /Users/rayman.chen/mycc/2-Projects/brain-product/mycc-brain/docs/architecture-ssot.md
  内容：SSOT 定义、三铁律、数据流规范（Air/Mini → Studio 允许/禁止的路径）、违反示例、事件上报接口草案
- 在 MANIFESTO.md 第十节追加 "Studio SSOT" 作为第 8 条决策原则
- 更新 deploy.sh 的开头注释，引用 architecture-ssot.md

**Agent-4（Codex 对抗审查）**：
- 用 codex:rescue 审查 HANDOFF-eval-migration-to-studio.md 的方案
- 挑战点：
  1. 迁移后 Studio 跑 eval 会不会影响 brain 服务的 SLA？
  2. Mini 的 sync-data.sh 还有哪些隐藏的覆盖风险？
  3. Air 的 deploy.sh 新 rsync 规则有没有遗漏？
  4. 事件上报 API 的设计有没有更简单的替代方案（比如 journald）？

**Agent-5（Phase 1 零数据排查，见 HANDOFF-phase1-zero.md）**：
- 验证 Studio 的 evolution cron (07:00) 是否在跑
- 读 src/services/evolution-engine.ts 找数据生成断点
- 手动触发 runDailyEvolution() 看能否产生 evolution-actions / evolution-tests / diagnosis-confidence
- 如有需要，Codex 对抗审查 evolution pipeline

## 约束
- /effort max，agent team 并行
- **不要跑 deploy.sh**（会重启 brain，且需要先验证新 exclude 规则）
- Agent-2 和 Agent-5 都要 SSH 到 studio-pub，注意串行不冲突（或用不同的操作）
- 每次关键写入前，先备份 Studio 上的 eval-result.json 和 trust-state.json 到 /tmp

## 成功标准
1. Mini 不再有 eval cron，sync-data.sh 不再覆盖 brain 运行时数据
2. Studio 手动跑 eval 成功，eval-result.json 是今天的新数据，15 分钟内不被覆盖
3. Admin UI 进化中心显示 2026-04-10 的真实 eval 结果
4. architecture-ssot.md 文档落地，MANIFESTO 更新
5. Phase 1 零数据的根因被定位（解决与否不强求，本 session 可留待下个）

## 如果发现问题
- Codex 不好用就直接自己做（之前 codex:rescue 有时会卡在 "Thread ready"）
- 任何文件冲突：先 git diff 确认，再手动 merge
- 新发现的 bug：追加到 HANDOFF 文档末尾，不要淹没在对话里

/brain-review 先跑一次对齐纲领再开始
```

---

## ⚠️ 本 session 已做的事（下个 session 不要重做）

| 修复 | 状态 |
|------|------|
| eval.ts 优雅降级（GEMINI KEY 缺失时） | ✅ Air + Studio + Mini（刚推） |
| eval-report.ts avgCol 零值修复 | ✅ Air + Studio + Mini（刚推） |
| run-eval.sh Codex 加固版 | ✅ Air + Studio + Mini（刚推） |
| deploy.sh 排除运行时数据 | ✅ Air 本地（未执行） |
| Studio 装 Node v22.22.2 | ✅ |
| Studio .env.local 补 ADMIN_PASS | ✅ |
| Studio crontab 恢复 eval @06:00 | ✅ |
| Admin UI 红点→黄点（401 时） | ✅ Studio |
| sync-data.sh 停止 eval-result.json 同步 | ✅ Air + Mini |
| Studio eval-result.json 手动重写 | ✅（但可能被其他未知脚本再次覆盖，见 Phase 2.6） |

---

## 📂 相关文件速查

### 代码
```
src/eval/eval.ts                # 已修（优雅降级）
src/eval/eval-report.ts         # 已修（avgCol 零值 + generationSkipped）
src/services/evolution-engine.ts # 未动（Phase 1 排查要看）
src/server.ts:1370              # scheduleEvolution()
src/admin/admin-ui.html:1212    # phase1-readiness 渲染
```

### 脚本
```
deploy.sh                       # 已改未部署
scripts/run-eval.sh             # Codex 加固版，已同步 Studio + Mini
scripts/sync-data.sh            # 已停 eval-result.json 同步
```

### 文档
```
2-Projects/brain-product/HANDOFF-eval-migration-to-studio.md  ← 本文
2-Projects/brain-product/HANDOFF-phase1-zero.md               ← 附带任务
2-Projects/brain-product/MANIFESTO.md                         ← 纲领
```

---

**创建时间**：2026-04-10 12:20 CST
**创建者**：cc（Claude claude-opus-4-6）
