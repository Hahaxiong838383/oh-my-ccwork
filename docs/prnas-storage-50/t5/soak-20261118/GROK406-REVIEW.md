# 与主13的交叉讨论：404 的两条 P0，以及 A14 组内余量

只读复核，2026-11-18T01:00:14+08:00。未改业务源码，未改在跑的 1 小时文件，未 SSH，未另起 agent。生产配置未动。范围只有两条：404 在 `review-outage` 里的两个 P0 是否用错了拓扑；`CACHE-PROBE-RAW.json` 是否支持把组内“可用 ≥20%”改成保守工作集。P1、600k 的旧 NAS 启动失败、24 小时耐久都不在本次裁定里。

工作区 HEAD 是 `1a0ed70330fce2ddfc95e0ec86083f4313f9cfb9`。正在跑的 1 小时 harness 是 `4aed8139ea665a529d94d29e8e9c677bff549a34`。本机 `storage-ark-outage-load.ts` 的 SHA-256 是 `636da4e4bb056b2b55aaebd9200df720b1bfb8641212c62de08d6ad58e7b4088`，与 `OUTAGE-CANDIDATE.json` 的 `harness_sha256` 相同。runtime 仍是 `b1ce23aecf2a699c55f81942c76ee05ca48fa5f1`。

## 1. 404 的 P0：拓扑用错，两条阻断都撤销

404 读的是生产者脚本的未接 NAS 形态。主13描述的是同脚本加上显式 spool、受限 gateway 和 NAS runner 的形态。两条 P0 对这次 1 小时运行都不再成立。脚本里的失败关闭还在：真的收不到收据，恢复段仍会失败，不能改成“无收据即成功”。

`STATE.json` 的 `outage.status` 是 `RUNNING`，`started_ms=1794932870011`，`earliest_reconnect_ms` 正好加 3600000。`outage-observation-01.json` 与 `outage-observation-02.json` 里 `last_ack_ms` 仍是 null，`pending_records` 等于当时的 `accepted`。这是拒绝窗口内的预期，不是“没有 ACK 通路”的证据，也不是恢复通过。

本机状态目录没有云端 `OUTAGE-START.json` 副本，这次没有 SSH 去读它。启动关系由本地启动器和观测支持：`outage-cloud-start.json` 拉起 `p003-t5-ark-outage-driver` 且退出码 0；`outage-cloud-driver.py` 第 17 行把 `T5_OUTAGE_SPOOL` 设为 `/opt/p003/archive-t2-20261116/spool`；观测里的生产者 unit 处于 active，并已有 `last_success_ms`。

### P0-1 “没有 ACK，所以 1 小时后必然再等最多 2 小时并失败”：撤销

赞成主13，反对 404 对本次运行的阻断和它给出的修法。

未接 NAS 时，404 对代码的描述是对的。`storage-ark-outage-load.ts` 68–81 行在非 smoke 写完 `PRODUCER-RESULT.json` 后循环调用导出，直到 `pending_records=0`，单调钟上限 `2*3600000` ms。到点断言失败，不写 `RECOVERY-RESULT.json`。`storage-ark-export.py` 71–80 行只有 `spool.receipt(m)` 与本批 `archive_id/sha256/bytes/record_count` 一致时，才删 outbox、把批次标成 `complete` 并更新 `last_ack_ms`。导出自己不制造收据。

本次不是这条孤立路径：

- 生产者 33–34 行只接受本次 `root/spool`，或字面路径 `/opt/p003/archive-t2-20261116/spool`。驱动用 `--setenv` 传入后者，`--db` 是新的 `/opt/p003/archive-t5-20261117/p003-t5-ark-outage-01/ark.db`。驱动第 8 行要求该目录事先不存在。
- `storage-archive.py` 228–240 行的 gateway 只允许 `list`、`meta`、`read`、`ack`。`ack`（210–225 行）先核对已发布 manifest 的 sha、字节和条数，才写 `receipts/<id>.json`。
- `storage-nas-transfer.sh` 37–41 行先 `finalize`，再 `remote ack`。SSH 丢失确认时，同一 ID 重哈希后重试。
- `outage-nas-runner.py` 17–28 行用 `BatchMode`、`StrictHostKeyChecking` 调用 `list`，只拉 `kind==ark_checkpoint` 且 `created_at_ms>=` 本轮开始、尚未见过的包。本地 runner SHA-256 `7483ef7c8b4d9fb0c3ebc87d8d8e1dcad4b144748f6ea9fe13f94597c7585f84`，与 `outage-nas-setup.json` 里 NAS 上 `code/runner.py` 一致。
- `outage-gate.py` 10–13 行在 `until_uptime` 之前把 SSH 指到本进程已绑定、未 listen 的 `127.0.0.1` 端口，形成真实 TCP 拒绝。该文件 SHA-256 `e843127d662f895058906d715a57125d93ace111f7d1b213ebc9f0f09dfb8c9f`，与 NAS 上 `bin/ssh` 一致。`storage-nas-pull.sh`、`storage-nas-transfer.sh` 的本地哈希也与 setup 记录一致。
- 驱动给生产者单元 `CPUQuota=25%`、`MemoryMax=512M`、`Nice=15`、`IOWeight=10`、`RuntimeMaxSec=11100`，并在空闲低于 5GiB、fixture 超过 64MiB 或现役 ready 连续失败时停这个单元。

因此“必然没有收据”不适用于这次拓扑。404 要求删掉 68–81 行、断言没有收据后以 0 退出，会把真实 ACK 的成功条件换成“永远没有 ACK”。反对这个修法。在跑文件保持不动。

仍成立、但不是 P0 的部分：拒绝窗口结束前不能宣称恢复通过。若 gateway 没有写出匹配收据，或导出没有把 pending 清到 0，到期就是 FAIL，`full_t5_pass` 仍必须为 false。`verify-outage.py` 的 3700 条全账现在还没有输入，不能预填通过。

`outage-observation-01.json` 里的收据 `831209708dec4da38494638fde3416fc`，`verified_at_ms=1794932739348`，早于本轮 `started_ms`。那是已经关闭的合成 analytics 包，不是本轮 Ark ACK。

### P0-2 “必须拒绝既有 t2 spool”：撤销

赞成保留这次显式复用，反对“设置了 `T5_OUTAGE_SPOOL` 就直接失败”。

该路径是这次 allowlist 里唯一的外部 spool，也是 `adopt-final.py` 使用的归档原型。`NAS-FINAL-VERIFIED.json` 把那只包标成关闭的合成库，不是在线 Backup API。72 小时模型脚本写的是自己的 `root/spool`，不是这条路径。本轮源库是另一个新目录。

共享目录这个事实还在：`published/831209708dec4da38494638fde3416fc` 仍在同一根下。它不再构成 P0，因为写和拉的范围都被代码卡住：

- 导出只处理 `--db` 里的 `ark_archive_batch`。新批 ID 来自 `uuid.uuid4().hex`（`storage-ark-export.py` 34 行）。清理 payload、删除收据和 90 天元数据，都只针对这个库里的批次（54–61、100–116 行）。它不会按目录扫掉 `analytics_backup`。
- gateway 的 `list` 会看到根下全部已发布 manifest。选择发生在 runner：必须是 `ark_checkpoint`，且 `created_at_ms` 不早于本轮。那只合成包的 kind 是 `analytics_backup`，`created_at_ms=1794932078021`，早于 `1794932870011`，两条都不入选。
- `Spool.__init__`（`storage-archive.py` 79–86 行）要求 `absolute()` 与 `resolve()` 相同，并拒绝 `pending`、`published`、`receipts` 的符号链接。Node 侧 `path.resolve` 不跟随符号链接；路径字符串先被 allowlist 卡住，Python 再拒绝真实路径不符。这是失败关闭。

不扩大 allowlist，不把这条复用推广成任意环境变量。本次没有新增密钥或生产 SSH 配置。

## 2. A14 组内余量：赞成保守工作集，反对用它追认耐久

赞成主13的口径修正。反对两件事：把 kubelet 那种“整个 `inactive_file` 都可回收”原样拿来当通过门；把这次探针或任何公式修改写成 24 小时通过。

原 A14 文字是主机可用 RAM ≥20%，另有 CPU 平均 <70%、无 OOM/重启、磁盘预留（`docs/superpowers/plans/2026-11-16-p003-prnas-50-devices.md`）。`storage-load-resources.ts` 现在有两层：主机 `MemAvailable/MemTotal`（8–10、54 行），以及组内 `memory.current/memory.max` 的样本最大值 ≤0.8（24–26、39、54 行）。字段名叫 `cgroup_memory_peak_fraction`，读的是 `memory.current`，不是内核 `memory.peak`。后一层会把可回收 page cache 算进占用。

### 探针实际证明了什么

`CACHE-PROBE-RAW.json` 的范围字符串是 `DISPOSABLE_FILE_MEMORY_ACCOUNTING_NOT_APP_PERFORMANCE`。独立 64MiB 上限、自有 128MiB 文件，四次采样的分数与原文一致。exit 0，临时文件已删除，单元 `Result=success`。本评审不采用“CPU 10%、Nice 15、IOWeight 10”：这两个 JSON 和 `cache-headroom-probe.py` 都没有记下这三项。

`after_read`：`current=67096576`，`limit=67108864`，`inactive_file=55050240`，`active_file=0`，`file_dirty=0`，`file_writeback=0`。`raw_fraction=0.99981689453125`。`working_fraction=(current-inactive_file)/limit=0.17950439453125`。dirty 与 writeback 都是 0，所以保守公式和只减 `inactive_file` 在这四个点上相同。`oom`、`oom_kill`、`oom_group_kill` 都是 0。删文件后 `inactive_file=0`，raw 降到 `0.183349609375`，说明这批 cache 跟着自有文件走。

同时，`memory.peak` 等于 limit，`memory.events` 的 `max` 在读之后是 814，`pgscan_direct=pgsteal_direct=52096`。组确实顶到硬上限并发生直接回收；回收掉的是 inactive file cache，所以没有 OOM。若通过门改去读内核 `memory.peak/limit`，或要求 `max` 事件保持 0，这次探针仍会失败。peak 和 max 事件只作诊断。

这组数字只说明 raw `current/limit<=80%` 会把干净 page cache 打成假失败。它不测量业务延迟，不代表生产者那个 512MiB 组，也不能把已有 fresh 600k 或这次 1 小时记成 24 小时。

### 文档和公式

内核 cgroup v2（https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html ，本次读取的是该页）：

- 被追踪的用户态内存包括 page cache 和匿名内存。`memory.current` 是该组及其后代当前用量，因此含 page cache。
- `file_dirty` 是已修改、尚未写回的文件缓存。`file_writeback` 是正在写回的文件缓存。二者都不是可以立刻拿来再分配的空闲。
- `inactive_file` / `active_file` 是回收链表上的量。文档写明链表计数和类型计数不是一回事，`inactive_file+active_file` 可以不等于 `file`；shmem 在 anon 链表上。

Kubernetes 节点压力驱逐（https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/ ）：

- `memory.available := node.status.capacity[memory] - node.stats.memory.workingSet`。
- kubelet 从计算里排除 `inactive_file`，因为它假定这些页在压力下可回收。
- 同一页的已知问题写明：`active_file` 不计入可用。kubelet 不扣除 `file_dirty` 或 `file_writeback`。脏的 inactive 页会被它当成可用，这比验收门松。

建议的组内占用是：

```text
deduct = min(current, max(0, inactive_file - file_dirty - file_writeback))
working = current - deduct
通过条件：working * 5 <= limit * 4
```

也就是只把夹在 `0..current` 内的 `max(0, inactive_file-file_dirty-file_writeback)` 从 `current` 扣除，再要求工作集不超过 limit 的 80%。分母用 limit。`active_file`、匿名页、shmem、slab、内核内存和未落盘页都不扣除。

`file_dirty` 与 `file_writeback` 不是 `inactive_file` 的子集。脏页可以在 active 链表上。把它们整段从 `inactive_file` 减去，可能少算真正干净的 inactive 页，工作集会偏大。方向是保守的，适合作为通过门，但它不是精确的可回收字节数。

探针脚本第 14 行是 `max(0, min(inactive, current) - dirty - writeback)`。dirty 与 writeback 为 0 时它和上面的 clamp 相同。`inactive_file>current` 且 dirty>0 时两者不同。实现必须锁住上面的 clamp，不能原样抄探针那一行。

以下门保持原样：主机 `MemAvailable/MemTotal>=0.2`，组 CPU 配额平均 <70%，OOM 与 `oom_kill` 相对首样本不得增加，`boot_id`、pid、cgroup、内存上限和 CPU 配额不得变，磁盘最低空闲仍是 `4.5*1024**3`，原有 ACK 与查询延迟门不动。`memory.max` 缺失、非正数或为 `max` 时，组样本无效。`inactive_file`、`file_dirty`、`file_writeback` 任一缺失、非整数或为负，样本失败。禁止把缺失字段当成 0：把 dirty 当成 0 会把脏页算成可用，那是假通过。

`complete_24h_evidence` 仍要求观测时长不少于 86400000ms。公式改正后也不接受短样本或 fresh 600k。

业务 runtime 不改。在跑的 1 小时生产者、driver 和 NAS runner 不改。资源工具要等下面的边界测试写进 `storage-load-resources` 的测试之后再改。

### 最小边界测试

用固定的 `memory.current`、`memory.max` 和 `memory.stat` 文本，不依赖再次占用页面，也不碰在跑的组。

1. 回放 `after_read` 的字节。raw 门失败，保守工作集 `12046336/67108864` 通过。OOM 仍为 0。这个用例只锁定会计，不产生 24 小时结论。
2. 反例：limit 1000，current 900，`inactive_file` 800，`file_dirty` 800，writeback 0。只减 inactive 会得到工作集 100 并假通过。保守公式得到 900，必须失败。writeback 800、dirty 0 再做一次。
3. `active_file` 900、`inactive_file` 0、current 900、limit 1000。工作集 900，失败。断言没有减 `active_file`。
4. 边界用整数：limit 1000、current 800、inactive 0 时 `working*5<=limit*4` 通过；current 801 失败。
5. `inactive_file` 150、current 100、dirty 80、writeback 0。deduct 必须是 70，working 是 30。这组用来防止抄探针脚本的另一表达式。
6. dirty 大于 inactive：inactive 10、dirty 40、current 50。deduct 为 0，working 为 50，不得出现负数。
7. `inactive_file` 大于 current 且 dirty 为 0：deduct 等于 current，working 为 0，不得为负。
8. 缺 `file_dirty`、缺 `inactive_file`、缺 `file_writeback`、负数字段、`memory.max` 为 `max`，都失败，且不能靠默认 0 算出一个分数。
9. 组工作集只有 10% 时，主机 MemAvailable 比例 0.199 仍失败；等于 0.2 才过主机门。OOM 增量、配额或身份变化、磁盘低于 4.5GiB、配额 CPU 平均 70，各自仍然失败。
10. 观测短于 86400000ms 时 `complete_24h_evidence` 为 false。不得把 fresh 600k、这次探针或在跑的 1 小时放进 24 小时通过。
