# Studio SSOT 架构

> mycc-brain 运行时数据的 Single Source of Truth 规范
> 创建日期：2026-04-10 | 版本：1.0
> 关联纲领：MANIFESTO.md 第十节第 8 条

---

## 一、背景

mycc-brain 长期以来存在一个隐蔽但致命的架构缺陷：运行时数据的写入权分散在 Air、Mini、Studio 三台机器上，再通过 `scripts/sync-data.sh` 的 rsync 机制反复互相覆盖。这种"多头写入 + 文件级 rsync 覆盖"是典型的分布式地狱，任何一次 cron 失败都可能把错误数据在 15 分钟内"同步"到全集群。

**血泪教训（2026-04-10）**：
- Mini 的 eval cron 因 env 缺失（`GEMINI_PROXY_KEY` / `ADMIN_PASS` 不在 launchd 上下文）而连续失败，写出零值或 stale 的 `eval-result.json`
- Air 的 `sync-data.sh` 每 15 分钟把 Mini 的错误 `eval-result.json` rsync 覆盖到 Studio
- 本 session 在 Studio 手动修 `eval-result.json` 5 次全部被 Mini 的 sync 在 15 分钟内回滚
- 同样的 pattern 也发生在 `evolution-log.jsonl`、`trust-state.json` 等运行时状态文件上

**根因**：没有明确"谁是唯一写入者"，导致每台机器都觉得自己手里的版本是对的。修复办法不是"优化 sync 逻辑"，而是**从架构上确立单一真相源（SSOT）**。

从 2026-04-10 起，Studio 正式成为 mycc-brain 所有运行时数据的 Single Source of Truth。

---

## 二、SSOT 定义

### 什么是运行时数据？

brain 的数据可以按"是否在生产跑时被修改"划分为五类：

| 类别 | 示例 | 写入权 |
|------|------|--------|
| 代码 | `src/`, `scripts/`, `package.json`, `tsconfig.json` | 任意机器，通过 git + deploy.sh |
| 模板 | `data/SOUL.md`, `data/constitutional.yaml` | 首次部署写入（`rsync --ignore-existing`），之后只读 |
| 图谱快照 | `data/graph-config-snapshot.json` | deploy.sh 每次生成并覆盖（它是 deterministic 的） |
| **运行时数据** | `eval/eval-result.json`, `data/trust-state.json`, `data/evolution-log.jsonl`, `data/evolution-actions.jsonl`, `data/evolution-tests.jsonl`, `data/diagnosis-confidence.jsonl`, `data/events-audit.jsonl`, `data/veto-spiral.jsonl`, `data/observe-*.jsonl` | **只属于 Studio 本地进程** |
| 记忆镜像 | `~/mycc-data/0-System/`, `~/mycc-data/claude-memory/`（注意不是 `~/mycc-brain/`） | Air/Mini 推送（只读镜像，brain 只读消费） |

### 什么是 SSOT？

Single Source of Truth（单一真相源）意味着：**对每一份运行时数据，全世界只有一个写入者**。写入者必须是本地进程（不是远程 rsync），读取者可以是多个，但都必须通过这个唯一写入者暴露的接口拉数据，而不能"自己 rsync 一份出来修改"。

Studio 是 mycc-brain 的 SSOT。具体地：
- brain 的所有运行时数据文件，**只能由 Studio 上的本地进程写入**（brain server、cron scripts、eval.ts、evolution-engine）
- Air/Mini 要把数据"推"到 brain，必须经由 **API 事件上报**（`POST /admin/api/events/report`），不得通过 rsync 直接覆盖文件
- 部署同步（deploy.sh）只允许同步代码、脚本、模板和图谱快照，**严禁**触碰 `data/*.jsonl`、`data/*.json`（运行时状态）和 `eval/` 目录

---

## 三、三铁律

### 铁律 1：brain 运行时数据的写入权只属于 Studio 本地进程

- **合法写入者**：
  - `src/eval/eval.ts`（由 Studio 的 cron 或 brain 进程触发）
  - `src/services/evolution-engine.ts`（brain server 内触发）
  - `scripts/run-eval.sh`（Studio crontab 的 `0 6 * * *`）
  - `src/services/trust-state.ts`（brain server 内）
  - 未来的 `src/services/event-merger.ts`（接收 API 事件后的合并器）
- **原因**：本地写入是原子的，文件锁由 OS 保证；跨机 rsync 不保证顺序、不保证完整性，容易在 partial write 时被 sync 采样到中间态。
- **违反**：任何机器上跑的脚本都不许对 Studio 的 `~/mycc-brain/data/*.json*` 或 `~/mycc-brain/eval/*.json` 执行远程 rsync 写入。

### 铁律 2：Air/Mini 向 Studio 推数据必须通过 API 事件，禁止文件级 rsync 覆盖

- **合法路径**：`POST /admin/api/events/report`（详见第六节草案）
- **非法路径**：
  - `rsync -az <air-or-mini>:... studio:~/mycc-brain/data/`
  - `rsync -az <air-or-mini>:... studio:~/mycc-brain/eval/`
  - `ssh studio 'cat > ~/mycc-brain/data/trust-state.json' <<< "{}"`
- **原因**：API 事件天然带 `event_id`（幂等键）、时间戳、来源标识和可审计的 body；rsync 覆盖是无脑的文件替换，既不幂等也不可回溯。
- **例外**：`~/mycc-data/` 目录（Studio 上的只读记忆镜像，路径明确不是 brain 目录）可以继续被 Air/Mini 的 sync-data.sh 单向推送，因为它与 `~/mycc-brain/data/` 是两个独立路径，brain 只读消费，不会回写。

### 铁律 3：部署同步（deploy.sh）只传输代码和模板，绝不动运行时数据目录

- **允许同步**：
  - `src/`, `scripts/`, `tools/`（代码）
  - `package.json`, `tsconfig.json`, `ecosystem.config.js`（构建/进程管理）
  - `data/SOUL.md`, `data/constitutional.yaml`（模板，`--ignore-existing`）
  - `data/graph-config-snapshot.json`（deterministic 快照，每次重新生成）
  - `docs/`（文档，只读）
- **禁止同步**：
  - `data/*.jsonl`（所有 append-only 日志）
  - `data/*.json`（除了上面白名单，其它都禁止）
  - `eval/eval-result.json`、`eval/eval-*.tsv`（运行时评测产物）
  - `data/events-audit.jsonl`（未来的事件审计日志）
- **原因**：deploy.sh 是从 Air 到 Studio 的单向覆盖，如果不排除运行时数据，Air 本地过期的缓存会无声无息地覆盖 Studio 上由 brain 进程刚写入的最新状态。
- **实现**：`deploy.sh` 在 rsync 中使用 20+ `--exclude` 规则，详见 2026-04-10 版本。

---

## 四、数据流规范

### 允许的数据流

```
[Air 本地代码]
   |
   | git push / deploy.sh rsync（src/ scripts/ 模板）
   v
[Studio: ~/mycc-brain/]  <----+
   |                          |
   | local write              |
   v                          |
[Studio: ~/mycc-brain/data/]  |
[Studio: ~/mycc-brain/eval/]  |
   |                          |
   +-- brain server 读 --+    |
                         |    |
[Air/Mini 的记忆文件]    |    |
   |                     |    |
   | sync-data.sh rsync  |    |
   v                     |    |
[Studio: ~/mycc-data/]   |    |
   (只读镜像)             |    |
                         |    |
                   brain 只读 |
                              |
[Air/Mini 事件]               |
   |                          |
   | POST /admin/api/events/report
   v                          |
[Studio: event-merger] ------+
   （合并后由本地进程写入 SSOT）
```

三条合法数据流：
1. **代码 / 模板**：Air → Studio（deploy.sh，单向，排除运行时数据）
2. **记忆镜像**：Air/Mini → Studio 的 `~/mycc-data/`（sync-data.sh，单向，brain 只读消费）
3. **事件上报**：Air/Mini → Studio 的 `POST /admin/api/events/report`（有 event_id 幂等、有审计日志）

### 禁止的数据流（反面教材）

历史上 `sync-data.sh` 曾经包含如下**错误**的 rsync 规则，现已全部注释或删除：

```bash
# 【反面教材 1】eval-result.json 的跨机覆盖
# 禁止原因：Mini 的 eval cron 失败时，会写 stale/零值的 eval-result.json
# 然后每 15 分钟把错误数据覆盖 Studio 的正确版本
# EVAL_RESULT="$HOME/mycc/2-Projects/brain-product/mycc-brain/eval/eval-result.json"
# if [[ -f "$EVAL_RESULT" ]]; then
#     do_sync "$EVAL_RESULT" "mycc-brain/eval/eval-result.json"
# fi

# 【反面教材 2】evolution-log.jsonl 双向追加
# 禁止原因：两台机器都 append 会导致事件错序 + 重复
# do_sync "$HOME/.../data/evolution-log.jsonl" "mycc-brain/data/evolution-log.jsonl"

# 【反面教材 3】trust-state.json 跨机覆盖
# 禁止原因：trust-state 是 brain 的运行时状态，任何外部写入都会破坏一致性
# do_sync "$HOME/.../data/trust-state.json" "mycc-brain/data/trust-state.json"
```

只要是"machine A 直接写 machine B 的 brain 运行时文件"，无论是 rsync、scp、`ssh cat >`、还是 `curl -X PUT`，都属于铁律 2 禁止的范围。

### 未来的数据流（事件上报）

`POST /admin/api/events/report` 是 Air/Mini 向 Studio 传递数据的唯一合法入口。它不是简单的文件上传，而是：
- 带 `event_id`（UUID v4）作为幂等键，重复投递只记一次
- 带 `source`（air/mini/nas/remote-mbp）和 `timestamp`，全链路可追溯
- 带 `type`（eval_result / trust_event / memory_intake / deploy_complete / skill_created / ...），由 Studio 的 event-merger 按 type 路由到不同的合并器
- 写入 append-only 的 `data/events-audit.jsonl`，成为不可篡改的审计流水
- merger 决定最终落到哪个 SSOT 文件（比如 `eval_result` 事件进 `eval/eval-result.json`，但只有当源时间戳比本地新且数据质量检查通过时才会覆盖）

这样即使多台机器并发发事件，Studio 也能保证单点序列化，符合 SSOT 的核心语义。

---

## 五、违反示例 × 修复方案

### 案例 1：Mini eval cron 覆盖 Studio 正确数据

- **违反**：铁律 2（rsync 覆盖运行时数据）+ 铁律 1（非 Studio 的进程写入 SSOT）
- **历史表现**：Mini 的 `run-eval.sh` 因为 launchd 环境变量缺失（`GEMINI_PROXY_KEY` 没传入）而连续失败，写出零值的 `eval-result.json`。Air 的 `sync-data.sh` 每 15 分钟把 Mini 的错误文件 rsync 推到 Studio，覆盖 Studio 上由 cc 手动修复的正确版本。一个 session 内发生了 5 次这样的覆盖。
- **修复**：
  1. 删除 Mini crontab 中的 `run-eval.sh` 条目
  2. 在 Air 的 `sync-data.sh` 中注释掉 `eval-result.json` 的 rsync 块（见 sync-data.sh 第 50-63 行）
  3. 在 Studio 上恢复 `0 6 * * * run-eval.sh` 作为唯一的 eval 写入者
  4. 验证：`stat ~/mycc-brain/eval/eval-result.json` 的 inode 在 15 分钟内不变

### 案例 2：deploy.sh 覆盖 Studio 运行时数据（长期潜 bug）

- **违反**：铁律 3（部署同步污染运行时数据）
- **历史表现**：Air 本地的 `data/` 目录保留着旧的 `trust-state.json`、`evolution-log.jsonl` 等文件（因为 git 追踪了它们或者曾经追踪过）。每次 `bash deploy.sh` 的 rsync 都会用 Air 的 stale 版本覆盖 Studio 上由 brain 进程正在写入的最新版本。这个 bug 潜伏了数周没被发现，因为部署频率不高，但每次部署都是一次"无声的回滚"。
- **修复**：在 `deploy.sh` 的 rsync 命令里追加 20+ 条 `--exclude` 规则，把所有运行时数据文件和目录明确排除。2026-04-10 版本已生效。
- **加固**：deploy.sh 头部注释已追加"遵循 Studio SSOT 原则"的说明，引导后续维护者先读本文档。

### 案例 3：evolution-log.jsonl 双向追加

- **违反**：铁律 1（非唯一写入者）
- **历史表现**：早期 Mini 的 evolution cron 和 Studio 的 brain server 都会 append 到 `evolution-log.jsonl`。通过 rsync 同步后，两份 append-only 日志被简单覆盖而非合并，导致事件错序、行数不一致、下游 Admin UI 渲染时出现幽灵记录。
- **修复**：Mini 侧关闭 evolution cron 写入；Studio 的 brain server 成为唯一写入者；历史 rsync 规则从 sync-data.sh 中移除。

### 案例 4：claude-memory 被 sync-data.sh 覆盖

- **违反**：本来不违反铁律（因为 claude-memory 进 `~/mycc-data/` 是只读镜像，不是 brain 运行时数据）
- **潜在风险**：如果未来有人"图方便"把 `~/mycc-data/claude-memory/` 软链或 rsync 到 `~/mycc-brain/data/claude-memory/`，就会变成违反铁律 2 的反面教材
- **修复**：保持 `~/mycc-data/` 和 `~/mycc-brain/` 的严格分离。brain 只读 `~/mycc-data/`，不写入；需要消费数据时通过相对路径或配置读取，禁止 symlink 到 `~/mycc-brain/` 内部。

### 案例 5：（未来提醒）直接 ssh 写 Studio 文件

- **违反预警**：铁律 1 + 铁律 2
- **可能的触发场景**：某个 cc session 为了"快速修复一下 Studio 的 eval 结果"，运行 `ssh studio-pub 'cat > ~/mycc-brain/eval/eval-result.json' < local-fixed.json`。虽然本 session 2026-04-10 也这么做过，但那是在 sync-data.sh 和 deploy.sh 都还没修好的"临时修复"阶段。长期看这是违规的。
- **修复原则**：任何对 brain 运行时数据的修改都必须经过 SSOT 写入通道：
  - 合法方式 A：直接修改 `src/` 代码，让 brain 本地进程下次运行时生成新数据
  - 合法方式 B：通过 `POST /admin/api/events/report` 提交修复事件，由 event-merger 决定如何合并
  - 禁止方式：`ssh studio 'cat > ...'`、远程 rsync、scp 覆盖

---

## 六、事件上报 API 草案

### Endpoint

```
POST /admin/api/events/report
Authorization: Bearer <ADMIN_PASS>
Content-Type: application/json
```

### 请求体（JSON schema）

```json
{
  "event_id": "uuid-v4（幂等键，重复投递返回 duplicate）",
  "source": "air|mini|nas|remote-mbp|studio",
  "timestamp": "2026-04-10T12:34:56.789Z",
  "type": "eval_result|trust_event|memory_intake|deploy_complete|skill_created|veto_spiral|...",
  "payload": {
    "comment": "事件 type 对应的 schema，由各 merger 定义"
  },
  "signature": "可选 HMAC-SHA256，验证来源防伪造"
}
```

### 响应

```json
{
  "status": "accepted|merged|rejected|duplicate",
  "event_id": "uuid-v4",
  "merged_to": "data/trust-state.json 或 eval/eval-result.json（如 status=merged）",
  "reason": "如果 rejected 或 duplicate，说明原因"
}
```

### 幂等与去重

- `event_id` 作为去重键，重复投递返回 `duplicate`，不执行合并
- 按 `type` 路由到不同的 merger，每个 merger 有独立的合并策略
  - `eval_result`：比较 timestamp，只接受更新的数据；数据质量检查（字段非零、格式合法）
  - `trust_event`：增量合并到 `trust-state.json`，原子写入
  - `memory_intake`：append 到 `data/memory-intake-events.jsonl`，不覆盖已有记忆
  - `deploy_complete`：记录到 `data/deploy-history.jsonl`，用于审计
- 所有事件**同时**写入 append-only 审计日志 `data/events-audit.jsonl`，无论是否被 merge 成功。审计日志是事件的"原始底片"，merger 的决策只是派生状态。

### MVP 实现建议

- **Phase 1**：只支持单一 `type=eval_result`，用于 Mini/Air 的紧急评测结果上报。**但事实上 eval 已迁移到 Studio，此用例现在并不紧急**，可以延后实现。
- **Phase 2**：支持 `type=memory_intake`，让 Air 的 claude memory 变更通过 API 上报而非 rsync。这会逐步取代 sync-data.sh 对 `~/mycc-data/claude-memory/` 的 rsync。
- **Phase 3**：支持 `type=trust_event`，为未来的多实例 trust 汇总做准备（如果真的有多 brain 实例的话）。
- **Phase 4**：支持 `type=skill_created`、`type=deploy_complete` 等审计型事件，不修改 SSOT，只进 `events-audit.jsonl`。

---

## 七、与 MANIFESTO 的关系

本文档是 MANIFESTO.md 第十节第 8 条决策原则的展开：

> **8. Studio SSOT > 分布式写入** — brain 运行时数据只在 Studio 本地进程写入，Air/Mini 通过事件上报（API POST），禁止文件 rsync 覆盖。详见 [mycc-brain/docs/architecture-ssot.md](./architecture-ssot.md)

### 与其他原则的关系

- **与原则 2「可观测 > 可自主」**：SSOT 让每个运行时状态有且只有一个权威版本，观测时不用纠结"哪台机器的数据才对"；审计日志 `events-audit.jsonl` 进一步提升可观测性。
- **与原则 3「可回滚 > 可优化」**：SSOT 让数据有唯一历史线，回滚时只需要在 Studio 本地操作，不用担心其他机器的"rsync 幽灵"把你的回滚再覆盖回去。
- **与原则 6「实时沉淀 > 批量整理」**：事件上报天然是实时的（发了就立即进审计日志），完全符合纲领；相比之下 rsync 是批量的、延迟 15 分钟的，与纲领精神相悖。
- **与原则 7「三层递进，不跳级」**：SSOT 是配置层（rules-driven）的基础设施，支撑模型层的数据准备。没有 SSOT，模型层的训练数据就会被"谁写入谁算数"的混乱污染。

---

## 八、修订记录

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0 | 2026-04-10 | 初版。基于 Mini eval cron 覆盖 Studio 正确 eval-result.json 的事故，正式确立 Studio 为 brain 运行时数据的 Single Source of Truth。明确三铁律、允许/禁止的数据流、事件上报 API 草案。同步追加到 MANIFESTO.md 第十节第 8 条，更新 deploy.sh 头部注释。 |
