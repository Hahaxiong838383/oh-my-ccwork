# H 平台多租户隔离演进（Claude Code 参考）

> 状态：架构提案，尚未实施。
> 当前设计基线：Bridge v1.35.0 / 全 Bot 行为契约 `2026-07-30.2`。
> 代码仓完整真源：`feishu-grok-bridge/docs/architecture/2026-07-30-multi-tenant-isolation-evolution.md`。

## 一句话决策

不要直接删除 bwrap，也不要把容器当成完整多租户方案。目标是：

> **共享控制面 + 签名 tenantContext + Tool Gateway + 分级执行单元 + 数据强制隔离**

## 当前风险

1. bwrap 仍共享宿主机内核。
2. 当前 `--share-net` 允许共享宿主机网络 namespace/loopback。
3. Bridge 会在同一进程解密多个 Bot 凭据。
4. 多租户仍共享 Runner Worker 服务和 SQLite 故障域。
5. Runner 有 Shell 时可自行组合 CLI、文件和网络能力，权限判断分散。

## 推荐执行等级

| 等级 | 场景 | 方式 |
|---|---|---|
| L1 | 对话、查记忆、结构化飞书 API | 共享 No-Shell Worker，只能走 Tool Gateway |
| L2 | Grok/Kimi/OMP CLI、可信平台 Skill | 每租户 Rootless Tenant Cell + cgroup + netns，保留 bwrap或gVisor |
| L3 | 用户代码、未知依赖、私有 Connector、高合规 | gVisor 或预热 microVM |

执行等级由平台策略决定，模型不能自行降低隔离等级。

## 实施顺序

### P0

1. tenantContext 从 Bridge 一次生成并签名，全链贯穿 RPC、Tool、Memory、Outbox、TaskSessionLog。
2. Tool Gateway 先代理飞书写操作、记忆写入和 Connector；Runner 不持长期凭据。
3. 每租户 systemd Slice/cgroup，限制 CPU、内存、进程和墙钟。
4. 去掉 `--share-net`，改独立 netns 或强制出站代理，禁止访问宿主机 loopback。
5. 增加跨租户文件、工具、数据、网络、凭据和资源竞争负向测试。

### P1

- Rootless Tenant Cell；不活跃 Cell 停止但 HOME/session 持久化。
- 高风险 Skill 进入 gVisor；建立预热池、独立升级与回滚。

### P2/P3

- PostgreSQL `tenant_id + RLS`；企业租户独立 Schema/DB。
- 任意代码和高合规任务进入 microVM。
- Skills Hub 长期优先 Wasm/WASI capability 模型。

## 硬性验收

- 篡改 tenantId/appId/executionClass/过期时间必须 fail closed。
- A 不能读取或调用 B/owner 的 HOME、日历、记忆、Bot、Connector。
- Runner 环境、日志、trace、TaskSessionLog 中无长期凭据。
- Tenant Cell 无法访问 Bridge/Worker/控制面宿主机本地端口。
- A 压满资源时，B 的短任务仍能完成并由 B 的 Bot 主动送达。
- 原闭环保持：`Runner success → durable enqueue → send → Feishu ACK → terminal event`。
- 缺权仍发当前 Bot 权限卡，授权后自动续跑，不要求用户重发。
- 每阶段都要覆盖 owner、新增用户和存量用户，禁止用户特判。

## 回滚边界

- tenantContext、Tool Gateway、netns、Tenant Cell、RLS 分开 feature flag，禁止一次性切换。
- 先 audit-only/shadow，再自有测试 Bot、小流量、全用户。
- P0/P1 保留 bwrap；新链异常可回现有 Runner 路径，但不得绕过 Outbox、TaskSessionLog 或 ACK。
- 数据迁移采用双写、校验、切读、停旧写；失败不自动删除 SQLite/JSONL。

## Claude 动手前

1. 先读取代码仓完整架构文档和最新 `docs/pi-inspired-roadmap.md`。
2. 刷新实时版本、服务拓扑、用户数、KVM/rootless/gVisor 可用性。
3. 先做独立 spike 和回滚备份，不直接改生产执行路径。
4. 真机验收必须由真实 Runner 和对应 Bot 主动送达，留下 Feishu message ID。
