# Pi → H 平台架构借鉴分析与 P0 落地基线

> 用途：记录 `earendil-works/pi` 对 `feishu-grok-bridge` 的源码级对照结论，并作为 TaskSessionLog v1、per-file mutation queue 的设计与回滚基线。

## 研究快照

- Pi：`origin/main=c820aa26fe0907e053e881a957722693fc094c9c`，packages `v0.82.1`。
- H 平台：`origin/main=955b6d5dc27ae5bcddfe63b11054c3eb78f3bb95`，生产版本 `v1.28.0`。
- 结论：Pi 适合作为 H 平台的架构供体，不适合直接替换现有 Bridge。

## 证据链

### Durable Harness 的真实边界

Pi 的 Durable Harness 文档提出正确的不变量：session 作为 append-only 状态源；任务、队列、turn、provider、tool 都先落盘再对外确认；provider 流中断只能从 durable boundary 重启。

但当前实现中 `pendingSessionWrites`、`steerQueue`、`followUpQueue`、`nextTurnQueue` 仍在进程内；`SessionTreeEntry` 也尚未包含 `operation_started`、`queue_enqueued`、`tool_started` 等事件；coding-agent 尚未切到 AgentHarness。因此只能借设计，不能直接把当前 Harness 当作完整断点恢复实现。

### H 平台现状

H 平台的任务状态目前分散在：

- `tasks-bg.jsonl`：后台句柄与结果摘要；
- `traces/<date>/<chat>.jsonl`：`task_begin/task_end`；
- `sessionRuntime`：进程内 child、running、queued、stop；
- `sessionQueue`：进程内串行链；
- `.session-map.json`：逻辑会话与 Runner 会话映射；
- 控制面的记忆镜像与 ops JSON。

服务重启后当前只会把未结束后台任务标记为 `orphaned`，不会恢复执行。后台完成卡、Kimi 接力、授权续跑已经解决用户侧交付，但尚缺统一的任务状态日志和可归约恢复边界。

## 决策

### P0-1：TaskSessionLog v1

新增每用户私有 append-only 事件流，第一阶段只旁路记录，不替代现有 trace/background/sessionRuntime：

- `task_accepted`
- `background_yielded`
- `delivery_started`
- `delivery_acked`
- `task_completed`
- `task_failed`
- `task_cancelled`

事件只保存状态与引用，不保存 token、授权链接、密钥或跨用户数据。所有写入失败必须降级为日志告警，不得阻断既有任务链路。

### P0-2：per-file mutation queue

控制面记忆/Profile/ops 的同文件 read-modify-write 必须串行；不同用户、不同文件仍可并发。第一阶段解决单进程异步并发覆盖；未来多实例时升级为 SQLite transaction 或跨进程锁。

## TaskSessionLog v1 最小结构

```json
{
  "v": 1,
  "seq": 1,
  "eventId": "uuid",
  "taskId": "uuid",
  "runId": "uuid",
  "type": "task_accepted",
  "ts": "ISO-8601",
  "causationId": null,
  "engine": "kimi",
  "payload": {}
}
```

约束：

1. 同一日志文件 `seq` 单调递增。
2. 每次 append 只写一行完整 JSON。
3. `taskId` 跨后台、交付与完成事件保持不变。
4. `deliveryId` 作为外发幂等键；收到飞书 message ID 后写 `delivery_acked`。
5. 日志失败不改变现有任务结果。

## 回滚基线

生产变更前必须记录：

- `git rev-parse HEAD`；
- 服务启动时间与 PID；
- 目标文件 SHA-256；
- 精确文件备份目录；
- 测试基线和 `/health` 基线。

回滚顺序：

1. 停止新版本服务；
2. 恢复精确备份文件；
3. 运行语法检查和相关测试；
4. 重启服务；
5. 检查 6 个 Bot、队列、错误字段和旧功能；
6. 保留新产生的 TaskSessionLog 数据，不作为旧代码输入，因此无需删除。

## P0 落地结果（2026-07-28）

- 生产版本：`v1.29.0`；GitHub `origin/main=7817e74ec252e86851d23b8f8a779702fc2c6e97`。
- TaskSessionLog：每用户私有 `task-session-log.v1.jsonl`；owner 无 uid 自动 no-op；同文件 append 串行、`seq` 连续；坏尾行后可安全续写；事件 payload 按类型白名单落盘，URL/授权/Token/正文不进入日志；文件权限实测 `0600`。
- 事件时序：授权续跑成功后才写 `delivery_started`；飞书送达后写 `delivery_acked`；历史与去重收尾成功后才写 `task_completed`，避免假交付和假完成。
- per-file mutation queue：控制面记忆镜像、上下文和 Profile/记忆操作队列按 canonical file 串行；不同文件并发；单次 mutation 抛错不污染后续队列；写入使用同目录临时文件 + rename。
- 回归：Air 本地 Bridge `94/94`、控制面 `113/113`；dev198 Bridge `94/94`、控制面含既有补充用例 `115/115`；aliyun-hk 部署前全量 `115/115`。
- 线上：Bridge 6/6 Bot connected、错误 0、队列 0；6/6 用户目录可写；控制面内网/公网 `/healthz` 均为 `ok=true, version=v1.29.0`；日志未出现 `task-session-log append fail`。
- 回滚：Bridge `/home/chuan/.h-rollbacks/feishu-grok-bridge/20260728-143959-p0`；控制面 `/srv/h-control/backups/20260728-143959-p0`；详细基线与 SHA-256 见仓库 `docs/rollbacks/2026-07-28-p0-task-session-log.md`。
- 产品侧待川哥体验：发一条普通任务后，对应用户目录应新增/续写 TaskSessionLog；发 `>120s` 长任务仍应按既有 F5.2 机制在会话底部出现新完成卡，本次 P0 不改变该交付路径。

## P0 后续实战补充（2026-07-28）

- owner 与登记用户已统一后台移交、完成卡、错误脱敏和并发策略，不再以“owner 零影响”
  为理由保留两套用户可见行为。
- `sessionQueue` 的同 key 串行只代表会话链顺序，不代表全局算力已满。私聊有独立新任务且
  真实并发未满时，当前任务立即转后台，新任务直接开始。
- 后台移交只释放会话链；旧 Runner 在真实完成前继续计入 `workConcurrency.active`。这补上了
  直接释放队列 slot 会导致后台任务无限膨胀的缺口。
- Grok sticky session 正被旧任务使用时，新任务通过 preflight mint 新 session，避免两个
  Runner 并发 resume 同一 session。
- 真机一慢一快验收确认：快任务在慢任务完成前启动并先送达，最终两张完成卡都出现在会话
  底部；说明 Pi 的 durable boundary 思路必须与 H 平台现有 Feishu 交付契约结合，不能只看
  进程内队列或单元测试。

## 基于 Pi 分析的后续 TODO 与价值

| 优先级 | TODO | 解决的问题 | 预期收益 / 价值 |
|---|---|---|---|
| P1 | Delivery Outbox v1 | `delivery_started` 已落日志，但 Bridge 在飞书确认前崩溃时仍缺自动重放 | 消除“Runner 已完成但用户没收到卡”；支持幂等重试、重启补发和可审计送达 |
| P1 | Task reducer + Recovery Planner | TaskSessionLog 目前只记录，未归约成可执行恢复状态 | 重启后自动识别待送达、待授权续跑、已孤儿任务；先恢复交付，再逐步恢复执行 |
| P1 | RunnerAdapter contract | Grok/Kimi/OMP 生命周期、停止、usage、session 事件仍有适配分叉 | 新增模型或 Runner 不再改 Bridge 主流程；降低回归面并可做统一契约测试 |
| P1 | 并发容量唤醒与公平性 | 满载时同会话任务会排队，但容量后来释放后缺少显式公平调度策略 | 减少长任务占槽造成的尾延迟；避免某个会话或引擎长期饥饿 |
| P2 | Durable steer / follow-up queue | 用户在任务运行中发“继续、补充、改方向”仍主要依赖进程内链路 | 重启不丢补充指令；可清楚区分新任务、steer 和 follow-up，减少重复执行 |
| P2 | JSONL RPC worker boundary | Bridge 与 Runner 同进程耦合，Runner 卡死会放大到消息网关 | Runner 崩溃隔离、背压清晰、可独立升级；为多机 worker 和 GPU Runner 铺路 |
| P2 | SQLite / 跨进程事务队列 | per-file mutation queue 只保证单进程，不覆盖多实例并发写 | 支持 Bridge/控制面水平扩展；从根上消除跨进程 lost-update |
| P3 | Session compaction + fork | 长 session 体积持续增长，串行上下文难以并行探索 | 降低 token/延迟成本；支持从同一上下文安全派生多个方案再合并 |
| P3 | Native Kimi Runner 影子测试 | 直接替换现有 CLI Runner 风险高，Pi 当前 Harness 也未完全 durable | 无用户影响对比成功率、延迟、工具兼容和成本，达标后再灰度切换 |

### 推荐执行顺序

1. **先做 Delivery Outbox v1**：最直接提升“完成必送达”，复用现有 `deliveryId` 和
   `delivery_started/delivery_acked`，改动最小、用户价值最大。
2. **再做 Task reducer + Recovery Planner**：把现有事件日志从“可查”升级为“可恢复”。
3. **同步定义 RunnerAdapter contract**：后续 durable steer、worker RPC 和新模型都依赖它。
4. **达到多实例需求前完成 SQLite 升级**：不要把单进程 mutation queue 误当分布式锁。
5. **最后做 compaction/fork 与 native Runner**：属于扩展性和成本优化，不抢送达可靠性的优先级。

## 30/60/90 天路线

- 0–30 天：TaskSessionLog、per-file queue、Delivery Outbox、Recovery Planner、
  RunnerAdapter、durable follow-up/RPC、SQLite、compaction/fork、Native Kimi shadow
  的代码与本地测试已完成；先做生产备份、主动真机和 chaos 验收。
- 31–60 天：拆独立 Runner worker 进程、增加公平容量调度与 orphan 人工恢复面，补齐
  SQLite integrity/backup/compact 运维闭环。
- 61–90 天：多机时升级 PostgreSQL/分布式 lease；增加 AI 语义 compaction、管理台
  fork/merge 和 Native Kimi 影子看板/灰度闸门。

## 扩展路线代码完成（2026-07-28）

- Delivery Outbox：最终结果先 durable enqueue；飞书 ACK 后才写 `delivery_acked` 与任务
  terminal event；稳定 request UUID 支持重启幂等补发。
- Recovery Planner：归约 TaskSessionLog、Outbox、follow-up、后台孤儿与 Runner RPC；安全
  自动恢复 pending delivery 和未开跑 follow-up。已 applied / RPC ACK 的计算只标 orphan，
  禁止在没有副作用幂等证明时盲目重跑。
- RunnerAdapter + RPC：三引擎共享 `run/runText/resume/cancel/status`；RPC 具备 request ID、
  ACK、结果、错误、取消、超时、背压、坏尾恢复与重启 orphan 检测。当前 worker 仍与
  Bridge 同进程，尚未获得进程级故障隔离。
- SQLite：TaskSessionLog、Outbox、follow-up、RPC 共用 `BEGIN IMMEDIATE` 事务库，WAL、
  FULL synchronous；同时保留 `0600` JSONL 镜像，`H_DURABLE_STORE=jsonl` 可回退。
- compaction/fork：只改变 Bridge 注入历史，不改变 Runner sticky session；checkpoint 有
  hash、来源条数和时间范围，fork 可归并摘要。
- Native Kimi shadow：默认关闭，仅 Kimi 主引擎稳定采样；不接飞书发送函数，不保存
  prompt、主回答、影子回答或 API Key。Native API 默认 `kimi-k2.6`；正式 Kimi Code
  订阅通道继续固定 `kimi-code/k3 → k3`，两套命名禁止混用。
- 本地最终回归：补 orphan 检测后的 `npm test` 为 `152/152`；专项恢复测试 `13/13`，
  `node --check bridge.mjs` 与 `git diff --check` 均通过。
- 仓库回滚文档：`docs/rollbacks/2026-07-28-pi-durability-roadmap.md`。

## 明确不采用

- 不直接部署 experimental `pi-server`。
- 不以 Pi 的 project trust 代替 H 平台 bwrap 隔离。
- 不直接替换飞书 Bridge、权限卡、后台完成卡、记忆/Profile 和 `short/full` 平台逻辑。
- 不直接复用第三方公共 OAuth client identity 作为 H 平台长期生产身份。
