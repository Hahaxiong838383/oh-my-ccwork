# PRnas T5 24h harness 只读准备审计

日期：2026-11-17
审计人：Grok 4.6（主13只读，未委派）
结论：**T5 整体未通过。现有 COVER01 只证明隔离新鲜库 50×6000 日批子项。当前 `storage-capacity-load.ts` 不是 24h 耐久 harness，按现写法拉满 24h 会自造内存与观测噪声。禁止把 COVER01 记成成熟/24h/50 档通过。**

本审计只读。未写源码、未部署、未 SSH、未对云端加负载、未改生产/设备/其它树、未 commit。09 点语音慢期间 root 在核日志，本轮零云端请求。

---

## 0. Git 核验

开工快照（本审计第一条命令）：

| 项 | 值 |
|---|---|
| 工作树 | `/Users/fu-121/.codex/worktrees/p003-prnas-storage-50-20261116` |
| 分支 | `codex/p003-prnas-storage-50-20261116` |
| HEAD | `7e695c80ad959131afbc5cc54ef800c9cef946f6` |
| 提交 | `test(p003): retain T4 recheck logs referenced by evidence hashes` |
| porcelain | 空（干净） |

COVER01 运行候选 `a3f2b982` 是 HEAD 祖先。`storage-capacity-load.ts`、`analytics/index.ts`、`checkpointer.ts`、`analytics-checkpoint.ts`、`analytics-rollup.ts` 在 `a3f2b982..HEAD` 字节相同。harness SHA-256：`0ede4aa1925df55f550f4b9a0b64076e0eab36622645d804e7b1233e8e523044`。

收尾复核 porcelain 出现他人写入，本审计未产生、未还原：

- `M docs/prnas-storage-50/t5/STATUS.md`（状态改为 PREPARED_AWAITING_USER）
- `?? docs/prnas-storage-50/T5-T6-READY-20261117.md`
- `?? docs/prnas-storage-50/t5/PREPARATION-360-20261117.json`

HEAD 仍为 `7e695c80`。下文源码结论以该提交已跟踪文件为准。

用户给出的私有路径 `/Users/fu-121/.local/state/p003-prnas-t5-20261117/LOAD-50x6000-COVER01.json` **不存在**。权威副本在仓内 `docs/prnas-storage-50/t5/LOAD-50x6000-COVER01.json`（1,143,473 B，SHA-256 `830b97b5af70522100f7b754dec6c052f53fa5a1234da3fec4b17fd24a3cbf95`）。启动记录在私有 `CLOUD-START-50x6000-COVER01.json`。

计划要求的 `docs/prnas-storage-50/ACCEPTANCE.md` 与 `scripts/storage-capacity-profile.ts` 均缺失。门禁以 `docs/superpowers/plans/2026-11-16-p003-prnas-50-devices.md` 第六节 A01–A15 及 `docs/prnas-storage-50/NEXT-TODO.md` T5.1–T5.3 为准，口径不缩小。

---

## 1. 24h harness：内存 / 观测 / 阈值

### 1.1 现脚本根本没有 24h 模式

`2-Projects/P003GameDemo20260513/apps/server/scripts/storage-capacity-load.ts` 是一次性增量负载：

- `stage` 固定为 `T5_INCREMENTAL_LOAD_NOT_FULL_ACCEPTANCE`
- 默认 `T5_DEADLINE_MS=3600000`（1h 摄入截止）；上限 172800000 只是客户端发完事件的墙钟上限，不是 soak 时长
- 50 路并行各发完 `events` 后退出；父进程再补一轮维护、等一次备份，写 `RESULT.json` 然后关掉 server
- JWT `setExpirationTime('48h')` 覆盖 24h 墙钟，但没有 24h 循环、没有第二日日批、没有持续 TTL 净回收观察
- 备份只在 T+5s 启动一次；维护每 300s，仅在客户端仍活着时有意义
- Ark 只 POST `/t5/ark/state`，没有 Brain 查询 deadline
- 云端 COVER01 unit：`RuntimeMaxSec=4200`、`CPUQuota=50%`、`MemoryMax=768M`、`Nice=10`、`IOWeight=20`、`--max-old-space-size=384`。该模板在 70 分钟会被 systemd 杀掉，跑不了 A14 的 24 小时

A14 要求：24h 连续运行且含日批/备份/维护重叠；无 OOM/重启；CPU 平均 <70%；可用 RAM ≥20%；无持续增长积压；云预留 4GiB+512MiB；NAS 预算余量 ≥20%。当前 harness 对其中每一条都没有对应采样字段或失败闭合。

### 1.2 会自造内存增长：会

父进程（`run`）与 HTTP/writer 同进程，再 spawn client / 维护 / 备份 / checkpointer。下列缓冲随时间线性增长，24h 会把「SUT 泄漏」和「测试器泄漏」混在一起。

| 缓冲 | 位置 | 现行为 | 9 分钟 COVER01 | 外推 24h（保持 1Hz 采样、不改代码） |
|---|---|---|---|---|
| `health: any[]` | 父进程 | 每 1s `/ready` 全文 `push`，结束时整数组写入 `RESULT.json` | 587 条，紧凑约 0.71 MiB；pretty RESULT 1.09 MiB | 86400 条，紧凑约 103 MiB，pretty 约 128 MiB |
| `health.jsonl` | 磁盘 | 同步 `appendFileSync` 每条全文 | 与内存重复 | 约 100+ MiB，合理；问题是内存再存一份 |
| `requests[]` + `completed[]` | client | 每次尝试和每次 200 的完整 `ids`+ACK 留内存，再整包写成 `client-result.json` | 4270 次尝试、1500 批 × 200 ID，ACK 里 ID 再存一份 | 若按天循环摄入，按日线性涨；父进程 `JSON.parse` 整文件 |
| `createLoadAccounting` 的 `Set` | 父进程，client 结束后 | 300k 事件 ID | 约 10–20 MiB 量级 | 多日 soak 按事件总数线性涨 |
| `percentile(success)` | 父进程 | 复制并排序全部 200 延迟 | 1500 点 | 可接受；应用运行直方图 |

SUT 侧 HTTP 层是有界的，不能把 harness 泄漏算到产品头上：

- `durations` 上限 1024（`analytics/index.ts` finally 分支）
- `globalHits` / `deviceHits` 60s 窗口
- writer 无队列，单 slot，忙则 `ANALYTICS_WRITER_BUSY` → 503
- RSS > 512 MiB 才 `ANALYTICS_MEMORY_PRESSURE` 503
- checkpointer 子进程 `--max-old-space-size=128`，PASSIVE 后仅当 WAL≥max 才 TRUNCATE

84k 旧工具 `deploy/analytics-smoke-and-load.mjs` 有 `maxRssSamples`、`rss_peak_bytes≤256MiB`、现网 `/health` P95 增量≤50ms。T5 脚本丢掉了这些门，也没有 CPUAccounting / MemoryPeak 必填字段。COVER01 的 systemd 文本是 `MemoryPeak=[not set]`（unit 已 inactive 后采集）。首轮无 cover 的 `LOAD-50x6000-01` 倒采到了 `MemoryPeak=693379072`（661.4 MiB / 768 MiB ≈ 86% cgroup，剩余约 14%，按 cgroup 解读已经低于 A14「可用 RAM≥20%」）。

### 1.3 会自造观测噪声：会

- 1 Hz `/ready`：每次 `SELECT analytics_meta`、WAL `stat`、`statfs`、复制排序 `durations`。24h = 86400 次额外 SQLite/磁盘 syscall，打在同一根盘、同一 0.5 CPU 配额上。
- COVER01 587 个 health 样本里 **123 个 `/ready`=503**：1 次起步 checkpoint stale，**122 次 `wal_pressure`**（WAL 峰值 271,462,712 B = 258.9 MiB，超过硬顶 256 MiB）。这是摄入合同内的 503，也会污染「服务是否就绪」时间序列。
- 50 并发 actor vs `LIMITS.concurrency=2` 且 writer 单 slot：2770/4270 次 HTTP 503（64.9%）。合同允许重试；P95/P99 只在 1500 次 200 上计算（A07「成功写入 ACK」口径正确），503 有计数。端到端排空 544.148 s 已记录。
- 维护 2/3 次墙钟 44.301 s / 42.854 s。A08「单轮≤30 秒」在混合写入下已经越线；进程仍 exit 0，因为脚本只断言 `code===0` 和最终 `dirty===0`，不采锁 p99、不采 prune 净条数、不采单轮预算。
- 最终 `dirty_days=0` 来自 **client 结束后又跑的一轮 maintain()**。health 序列里 244 个样本 `rollup_status=partial` 且 `remaining_dirty_days=1`。证明的是结束后追平，不是重叠负载期间持续干净。
- 最后一次 checkpoint `reclaimed=false`，WAL 仍 194.9 MiB。TRUNCATE 只在已经顶到 256 MiB 时触发；24h 重叠写入会反复打到 WAL 准入顶。

### 1.4 现有阈值清单（脚本实际 assert）

通过才 `exit 0` 的只有：

1. client exit 0
2. `integrity.complete`（精确 ID/seen/delta）
3. 50 个合成 Ark POST `family_coin/M-CARD-001`
4. 成功 ACK p95≤500 ms、p99≤2000 ms
5. 若开启维护：最终 dirty=0
6. 若开启备份：backup 子进程 exit 0

没有的 A14/A07/A08 项：OOM/重启、CPU%、MemAvailable、cgroup MemoryPeak、RSS 曲线斜率、WAL 高水位持续时间、锁 p99、prune 净吞吐、健康 P95 增量、NAS 余量、24h 墙钟。缺失字段当前不会让脚本失败，属于缺测即绿。

HTTP 父进程 RSS：COVER01 第一点 141.3 MiB → 峰值 291.4 MiB → 收尾 263.8 MiB；548/587 点 >256 MiB，0 点 >512 MiB。这是 9 分钟新鲜库。首轮 systemd MemoryPeak 661 MiB 含 client/维护/checkpoint 子进程。把 `health[]` 再堆 100+ MiB 后，768 MiB cgroup 没有安全余量。

---

## 2. 无需生产写入即可推进的最小测试与补丁建议

全部由 root 改代码。本审计不改仓库。本地测试只许 `p003-t5-` 新目录；禁止复用、禁止 `/server/data`、禁止打生产 `/health`、禁止 SSH、禁止新的云端 unit。

### 2.1 先做的本地红绿（不写生产、不加云负载）

1. **harness 有界观测失败测试（当前应红）**
   用 2 身份、每台 1 批、把 monitor 间隔注入成可测时钟，跑 ≥ 200 次采样。断言 `health.length` 有上限（建议 ring 256 或 1024），`RESULT.json` 不含完整 health 数组，只含 `health.jsonl` 路径 + RSS/WAL/disk/ready 的 min/max/last/超阈秒数。现实现会红：这是要修的缺陷，不是去删测试。

2. **A14 缺字段失败闭合（当前应红）**
   构造一份模仿 COVER01、`duration_ms=544148`、`MemoryPeak` 缺失、无 CPU 样本的 RESULT，断言 soak 判定器拒绝 `A14_PASS`。24h 通过必须同时具备：墙钟 ≥86400000 ms、systemd `MemoryPeak` 有数字、无 OOM/重启、CPU 平均、MemAvailable 序列、WAL 高水位秒数、dirty/积压斜率。

3. **WAL 顶满必须留下 reclaim 证据**
   用很小的 `walMaxBytes` 夹具写过阈值。断言出现 `wal_pressure`、随后 `reclaimed=true` 或明确 `reclaim_busy` 失败。COVER01 顶过 256 MiB 且最终 `reclaimed=false`，这条现在挡 24h。

4. **维护预算墙钟**
   对 `maintenance[].done-start` 断言 ≤30000 ms（A08 单轮），超时记 FAIL 并保留 JSON。COVER01 后两轮 44.3 s / 42.9 s 在该测试下为红。覆盖索引隔离 7.394 s 不能替代混合负载墙钟。

5. **容量纸面重算（纯本地算术，已有数字）**
   覆盖索引实测 +178,515,968 B / 600,000 facts = 297.53 B/fact。成熟库 54,000,000 facts → **+16,066,437,120 B ≈ 14.96 GiB / 副本**。迁移期五副本额外 ≈ 74.8 GiB。T4 180 天五副本已约 302 GiB（`CAPACITY-MODEL-FINAL.json` `target_devices_bytes=324086400000`）。加上 cover 后约 377 GiB 量级，外加现役占用和 12.5 GiB 预留。40 GiB 根盘放不下 44.87 GiB 成熟库，更放不下 cover 后的副本。把该算术固化成测试，避免未重算就宣称 T5.1 完成。

6. **既有会计测试保持**
   `analytics-load-accounting.test.ts` 已覆盖丢 ACK / 精确 ID / delta。24h 循环若复用 `Set`，加一条「跨日 ID 不得在内存无限累积、对账走 jsonl/DB」的红。

7. **会话 360 重叠提醒（测试名即可，不改 360）**
   `analytics/index.ts` 与 360 的 history/observations 挂载冲突已记在 `PREPARATION-360-20261117.json`。T5 补丁不要整文件覆盖该文件。

### 2.2 建议 root 打的最小补丁（仍不是 24h 通过）

按依赖顺序，全部隔离目录：

1. `health` 改 ring buffer；原始样本只追加 `health.jsonl`；`RESULT` 只写摘要。client `requests/completed` 同样只落 jsonl，父进程流式对账，禁止 `JSON.parse` 整包 24h 文件。
2. systemd：`RuntimeMaxSec` 至少 25h 才允许自称 soak；`CPUAccounting=yes`；在 unit 仍存在时采 `MemoryPeak`/`CPUUsageNSec`/`NRestarts`。缺失即 FAIL。
3. 观测与摄入解耦：health 采样降到 10–30 s，或独立 cgroup，避免 1 Hz `/ready` 抢 0.5 CPU 和同一块盘。
4. 维护结果解析 `analytics-rollup.ts` 的 JSON：`pruned` 条数、`partial`、墙钟；写入 `maintenance[]`。单轮 >30 s 或 `budget_exhausted` 且 dirty 不降 → 该轮 FAIL。
5. WAL：记录超过 256 MiB 的秒数；24h 结束时 `reclaimed` 或 WAL 回到远低于 max；否则 A14 积压/空间失控。
6. 明确子命令：`run` 保持增量日批；新增 `soak`（root 实现）必须失败闭合，在磁盘/MemoryPeak/有界遥测就绪前直接拒绝。禁止把 `T5_DEADLINE_MS=86400000` 套在现 `run` 上冒充 24h。
7. 覆盖索引继续 `T5_COVERING_INDEX=1` 实验开关，禁止生产启动迁移。容量公式按 2.1.5 重算后再谈成熟库。
8. 恢复 84k RSS/现网 health 增量门时，只打隔离 loopback，09 点语音调查结束前不要打生产 `:3001/health`。

这些补丁让 24h 有资格开跑。它们本身不是 A14 证据。

---

## 3. 现有证据无法证明的 T5 门禁（不缩范围）

计划第六节 A01–A15 + NEXT-TODO T5.1–T5.3。COVER01 / 本地 smoke / 首轮 FAIL 都不够签发 50 档。

### 3.1 COVER01 实际证明的范围（仅此）

隔离合成空库、`T5_COVERING_INDEX=1`、候选 `a3f2b982`、unit `p003-t5-50x6000-cover01`、localhost HTTP：

- 50×6000=300000 事件、1500 批精确入库，duplicated=0，database_integrity=true，544.148 s ≤ 1 h
- 成功 ACK p95=395.00 ms ≤500，p99=1088.17 ms ≤2000；attempts=4270，503=2770 全保留
- 合成 Ark POST 50/50 `correct`
- 三轮维护 exit 0，结束后 dirty=0，backup exit 0
- checkpoint failures/timeouts=0；unit `Result=success` `ExecMainStatus=0`
- stage 字段自己写着 `T5_INCREMENTAL_LOAD_NOT_FULL_ACCEPTANCE`

首轮 `ab88de96` / `LOAD-50x6000-01`：同样 300k 入库，dirty=1，整体 FAIL，MemoryPeak=693379072。失败记录保留。

本地 2×601 cover smoke：工具预检，darwin，不是云端规格。

### 3.2 未证明（完整清单）

| 编号 | 门禁 | 现证据缺口 |
|---|---|---|
| T5.1 资源 | 成熟字段宽度 300k/600k；cover 后重算 302GiB+占用+12.5GiB；扩容费用/IO | 40GiB 根盘（vda 42,949,672,960 B）；成熟库 44,871,368,704 B 放不进去；cover 额外 ~14.96 GiB/副本未写入容量模型；无新盘批复 |
| T5.1 工具 | 参数化 50 身份、固定种子、全量 429/503、ACCEPTANCE.md、profile 脚本 | 负载脚本有；ACCEPTANCE.md / `storage-capacity-profile.ts` 缺失 |
| A01 | 49/50 边界、第 51 台拒绝、配额 100 不虚增、400/409 | 无 |
| A02 | 合成 100 档配置逻辑 | 无 |
| A03 | 5 秒内各端读到配额 revision | 无 |
| A04 | 50 SN 币/卡/奖励/时间 100% 隔离；跨账号/epoch/GM | 仅合成 Ark 两个字段；无完整资产矩阵 |
| A05 | 定时+关键变化留档、崩溃恢复、manifest | 无 |
| A06 300k | 成熟/旧 raw、非满批、全局 600 rpm | 仅空库新鲜日；非满批只在本地 smoke；COVER01 50 路并行远超 2 槽并发 |
| A06 600k | 600k 积压 2 h | 无；`T5_EVENTS` 上限 60000，50×12000 未跑 |
| A07 ACK | 含 429/503 的成功写入分位 + 排空 | 新鲜库子项有；成熟库/600k/公网代理/Android 无 |
| A07 84k 回归 | RSS≤256 MiB，现网 health P95 增量≤50 ms | T5 脚本已去掉该门；COVER01 HTTP RSS 峰值 291 MiB；本轮禁止打生产 health |
| A08 | 90 天真实行数、fact 净清理 ≥600k/0.7 行/日、raw 300k/日、锁 p99≤100 ms、单轮≤30 s、30 min 内追平 dirty | 新鲜 1 日；混合维护 44 s；无锁 p99；无 TTL 净回收对到期增长；成熟 8944 万行未上云 |
| A09 | 同设备 Ark 查询 p99 低于内部 deadline 20 ms；超时注入 | 只 POST state |
| A10 | 基线/候选各 ≥50 轮语音；首声 p95；断连/无声/begin_timeout=0 | 脚本写明不用 health 冒充语音；未跑。09 点语音慢调查进行中，本轮禁止加语音负载 |
| A11 | 72 h 积压模型 + 真实断线 1 h；恢复 24 h 内排空 | 本地 spool backup 不是 NAS 断线；无 72 h |
| A12 | 洪峰/盘满/NAS 满/权限失败 → 503，不提前 ACK | 无专门超预算用例 |
| A13 | 中断、重复包、ACK 丢失、checksum、隔离恢复、seen、不复活旧 grant | 会计单元测试有 ACK 丢失；规模链路/NAS 恢复无新证据 |
| A14 | 24 h 连续 + 日批/备份/维护重叠；无 OOM/重启；CPU<70%；RAM≥20%；积压不涨；4GiB+512MiB 预留；NAS 余量≥20% | 最长云端样本 544 s；RuntimeMax 4200 s；MemoryPeak 缺失；无 CPU 序列；WAL 已顶满 122 s；harness 自造 RSS；成熟库/NAS 预算未测 |
| A15 | 现有 Analytics/Ark/设备/短信/绑定/搜索/倾听回归；>32 授权隔离回滚 | T5 未跑该矩阵；全仓既有类型错误仍在 |
| T5.3 Grok 复验 | 固定 SHA 独立复跑失败用例与 NAS 恢复 | 本文件是准备审计，不是复跑通过 |
| 50 档登记 | 全部通过后才登记已验证 50 | 已验证档仍 14；规划 50 可编辑 |
| 生产/设备 | 部署、扩 SN、23 点日批、timer | POSTLOAD 时 7 个受保护文件 SHA 未变；本轮未再碰生产 |

T2 的 44.87 GB 隔离备份/恢复、T4 的 994 MB 夹具与 10 行 TTL，保持原阶段结论，不能当作 T5 成熟云端混合或 24h。

---

## 4. 当前阻塞与下一步（仍等用户指令）

1. 云 40 GiB 根盘 vs 成熟 44.87 GB：物理放不下。未获新隔离盘之前，成熟 A08/A14 无法做代表规格的云测。本地快盘不能替代。
2. 24h 模板：`RuntimeMaxSec=4200`、无界 `health[]`、整包 `client-result.json`、1 Hz `/ready`、WAL 9 分钟已顶满。先按 §2 补有界观测和失败闭合，再谈开跑。
3. 09 点语音：root 在核日志。任何新的云端 T5 unit 都会与语音争 CPU/IO。本审计未加负载。
4. 会话 360 与 `analytics/index.ts` / `admin/index.html` 重叠。T5 补丁由 root 逐文件打，禁止整树覆盖。
5. 覆盖索引仍是实验开关。隔离 rollup 7.394 s、混合维护 44 s、空间 +14.96 GiB/副本。未完成 T5.1 重算之前，不能当作生产 schema。

**T5 状态：未通过。COVER01 = 新鲜日批混合子项。24h / 成熟 / 600k / 语音 / NAS / 50 档：全部未证明。**


---

## 5. 收尾 HEAD 漂移（他人文档提交）

审计开工 HEAD 为 `7e695c80`。落盘前 root 另提交 `9efbacac62ac98629668644e13069527a5547a30`（`docs(p003): prepare T5 T6 handoff and protect session360 changes`，2026-11-17 09:36:17 +0800），仅 3 个文档：`T5-T6-READY-20261117.md`、`t5/PREPARATION-360-20261117.json`、`t5/STATUS.md` 一行状态。harness / analytics 源码未变。本审计未执行该 commit，收尾 porcelain 空。源码结论仍对 `7e695c80`/`a3f2b982` 字节。
