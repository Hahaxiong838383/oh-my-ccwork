# 工作集门复核：同意更保守扣减，探针与加速计数都不是 24h

只读复核，2026-11-18T01:27:19+08:00。未改业务源码，未改在跑的 1 小时文件，未 SSH，未另起 agent。生产配置未动。`replay-cache.mts` 会覆写 `CACHE-PROBE-REPLAY.json`，本次没有运行它。

固定提交 `13b62db9c0039539eaa5bf887486023b64abc9cf`（`13b62db9`），父提交 `1a0ed70330fce2ddfc95e0ec86083f4313f9cfb9`。工作区 HEAD 就是这个提交。复核对象是该提交里的 `2-Projects/P003GameDemo20260513/apps/server/scripts/storage-load-resources.ts` 与 `storage-load-resources.test.ts`。提交说明是 `test(storage)`。`apps/server/src` 不在这个提交里。统计模块仍由 `storage-capacity-load.ts` 引用，下次新起的 harness 会装入新公式；这次没有重启在跑进程。

结论：同意用 `deduct=max(0,min(current,inactive_file)-file_dirty-file_writeback)` 代替 raw `memory.current/memory.max` 做组内 80% 门。这个扣减的工作集始终不小于 406 的 `min(current,max(0,inactive-dirty-writeback))`。异步计数不一致且存在 dirty/writeback 时，实现保留更多占用。raw 分数仍留在 `cgroup_memory_peak_fraction`。主机内存、CPU、OOM、磁盘和 24h 时长没有放宽。四条真实探针样本的两个公式相等，回放门为失败，`complete_24h_evidence` 为 false。本次没有实现缺陷。

## 公式

`storage-load-resources.ts` 第 49 行：

```text
deduct = max(0, min(current, inactive_file) - file_dirty - file_writeback)
working = current - deduct
组内通过：working / memory.max <= 0.8
```

分母是 `memory.max`。`active_file`、匿名页、shmem、slab、内核内存不扣。`file_dirty` 与 `file_writeback` 先从 `min(current,inactive_file)` 里减去，再把负数夹到 0。因此 `deduct<=current`，工作集不为负。

406 写的是 `min(current, max(0, inactive_file-file_dirty-file_writeback))`。对非负输入：

- `inactive_file<=current` 时，两者相等。
- `file_dirty=file_writeback=0` 时，两者都等于 `min(current,inactive_file)`。
- `inactive_file>current` 且 `file_dirty+file_writeback>0` 时，实现的 deduct 更小，工作集更大。

单测 `inconsistent-counters-retain-dirty` 把这条差异锁在门上：`current=999`、`inactive_file=2000`、`file_dirty=801`、`file_writeback=0`、`limit=1000`。实现得到 deduct `198`、working `801`、分数 `0.801`。本次用同一函数读到 `cgroup_missing_samples=0`、`cgroup_working_set_peak_fraction=0.801`、`cgroup_memory_peak_fraction=0.999`。样本被接受，不是缺字段被丢掉。406 的扣减是 `999`，working 是 `0`，同一套加速计数会把组内门打成通过。单测要求该门失败，实跑通过，所以当前实现没有退回 406。

406 举例 `current=100`、`inactive_file=150`、`file_dirty=80` 时，406 的 deduct 是 `70`、working 是 `30`；实现的 deduct 是 `20`、working 是 `80`。limit 为 `100` 时两者的组内分数都 `<=0.8`。会改变通过位的是上面的 `0.801`，不是这组 `0.8`。

`cgroup_memory_peak_fraction` 仍是样本期内 `memory.current/memory.max` 的最大值，第 50 行与第 67 行。它不读内核 `memory.peak`。通过位用的是 `cgroup_working_set_peak_fraction`。`clean-cache` 同时断言 raw `0.999` 与工作集 `0.179`，并且门通过。`memory.events` 的 `max` 只出现在 `linuxResources` 的 `cgroup_memory_max_events`，记录器不用它做通过或失败。

## 边界与失败关闭

缺字段、负数和非整数不进工作集。第 44 行要求 `cgroup_memory_bytes`、`cgroup_inactive_file_bytes`、`cgroup_file_dirty_bytes`、`cgroup_file_writeback_bytes`、`oom`、`oom_kill` 都是 `>=0` 的安全整数，且 `cgroup_memory_limit_bytes` 是正的安全整数。任一失败只增加 `cgroup_missing_samples`，不把缺项当 0。`complete_24h_evidence` 要求 `groupMissing===0`，所以这种样本不能打开 `local_resource_gate`。全部样本都缺组证据时，两个分数字段为 null。

`parseCgroupMemoryStat` 第 13–17 行同样要求这三项为非负安全整数。缺 `file_writeback`、负数、非数字都会抛错。解析结果不含 `active_file`。`memory.max` 为字面量 `max` 时限额写成 null，随后记为缺组。单测 `group-missing`、`missing-stat`、`negative-stat`、`missing-oom` 的门都是失败。

已由全长加速循环锁住的边界：

- `limit=1000`、`current=999`、`inactive_file=199`：working `800`，分数 `0.8`，通过。`inactive_file=198` 时 working `801`，失败。`800/1000===0.8`，`801/1000<=0.8` 为 false。
- `inactive_file=0` 时，`current=800` 通过，`current=801` 失败。这与 raw 分数相同。
- `dirty-cache`：`current=999`、`inactive_file=820`、dirty `700`、writeback `100`，deduct `20`，working `979`，失败。只扣 inactive 会得到 `0.179` 并错误通过。
- dirty 大于 inactive：`inactive_file=20`、dirty `500`、`current=999`，deduct `0`，working `999`，没有负数。
- `current=0` 且 inactive 为 0：working `0`，组内分数通过。
- `active_file` 不参与扣减。`current=999`、`inactive_file=0` 失败。

writeback 与 dirty 在第 49 行是同一项。单测里的 `dirty-cache` 即使忽略 writeback 仍会失败（working `879`）。本次另用函数计算了 `current=900`、`inactive_file=800`、dirty `0`、writeback `800`、limit `1000`：缺样本数是 0，raw 与工作集都是 `0.9`。忽略 writeback 时工作集会变成 `0.1`。实现扣了 writeback。这组没有放进提交里的全长循环，不构成实现缺陷，也不需要为此加框架。

## 没有放宽的门

第 66–67 行相对父提交，只把组内比较从 `groupMemoryMax<=.8` 换成 `workingSetMax<=.8`，并多返回工作集分数。其余条件仍是：

- `complete_24h_evidence`：`requiredMs>=86400000`，观测时长不短于 `requiredMs`，样本数大于 1，无不可用样本，无缺组样本，采样间隔 `<=10000ms`，主机 CPU 平均存在，身份未变，OOM 未增。
- 主机 CPU 平均 `<70`，组配额 CPU 平均存在且 `<70`。`quota-cpu-boundary` 的配额平均正好是 70，门失败。
- 主机 `MemAvailable/MemTotal>=0.2`。`199/1000` 失败。
- OOM 与 `oom_kill` 相对首样本增加则失败。
- 身份字段仍是 `boot_id`、`pid`、`cgroup`、内存上限、CPU 配额。
- 磁盘 `>=4.5*1024**3`。`disk_free_bytes=1` 失败。

`good` 路径仍断言 `summary(3600000).complete_24h_evidence===false`。短样本 `86399s` 的门失败。单测里能够得到 `local_resource_gate===true` 的路径使用 `n*10000` 的加速计数，文件头写明这不是真实一天。加速通过不能当作 24h 证据。

## 四条真实样本

`CACHE-PROBE-RAW.json` 的 `exit` 是 0，stderr 为空，`file_removed` 是 true，单元文本是 `Result=success`、`ExecMainStatus=0`、`ActiveState=inactive`。范围字符串是 `DISPOSABLE_FILE_MEMORY_ACCOUNTING_NOT_APP_PERFORMANCE`。限额都是 `67108864`。四个点的 `file_dirty`、`file_writeback`、`active_file`、`oom`、`oom_kill`、`oom_group_kill` 都是 0。这两个 JSON 没有记录 CPU 配额、Nice 或 IOWeight。

| 阶段 | current | inactive_file | raw | working | 两公式 deduct | events.max | memory.peak |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| before | 11317248 | 0 | 0.16864013671875 | 0.16864013671875 | 0 | 0 | 11321344 |
| after_write_fsync | 66985984 | 53477376 | 0.9981689453125 | 0.2012939453125 | 53477376 | 308 | 67108864 |
| after_read | 67096576 | 55050240 | 0.99981689453125 | 0.17950439453125 | 55050240 | 814 | 67108864 |
| after_own_file_removed | 12304384 | 0 | 0.183349609375 | 0.183349609375 | 0 | 814 | 67108864 |

工作集字节依次是 `11317248`、`13508608`、`12046336`、`12304384`。`after_read` 的 `12046336/67108864` 等于 `0.17950439453125`。后三个点的 `memory.peak` 等于限额；`before` 不等于。`after_read` 的 `events.max` 是 814。这些分数由当前提交的 `createResourceRecorder` 从原始字节重算，与 RAW 内嵌分数以及 `CACHE-PROBE-REPLAY.json` 的四个 summary 一致。重算没有写回 JSON。

四条样本都是单样本，`observed_ms=0`。回放范围是 `REAL_MEMORY_VALUES_WITH_SYNTHETIC_OTHER_COUNTERS_NOT_24H`。四个 `complete_24h_evidence` 与 `local_resource_gate` 都是 false。回放里的主机内存 `0.4`、磁盘 `10737418240` 和配额 `0.1` 是合成上下文，不是这只探针测到的主机值。四个工作集分数都不超过 `0.8`，其中最大的是 `after_write_fsync` 的 `0.2012939453125`；`after_write_fsync` 与 `after_read` 的 raw 分数高于 `0.8`。删自有文件后 raw 回到 `0.183349609375`。这只说明干净 file cache 会把 raw `current/limit` 打成假满，不代表业务延迟，也不代表 512MiB 生产者组，更不是 24h 通过。

仓库内 `docs/prnas-storage-50/t5/soak-20261118/CACHE-PROBE-REPLAY.json` 与 `D/CACHE-PROBE-REPLAY.json` 的 SHA-256 相同。

## 实跑

```text
cd 2-Projects/P003GameDemo20260513/apps/server
PATH=/Users/fu-121/.local/node-v24/bin:$PATH
/Users/fu-121/.local/node-v24/bin/node --import tsx scripts/storage-load-resources.test.ts
```

Node `v24.19.0`，`command -v node` 指向同一可执行文件。退出码 0。标准输出三行：

```text
PASS resource parser/counters: exact CPU weights, OOM/restart/gap/short/unknown/memory/disk fail closed; accelerated only, not 24h
PASS quota CPU, cgroup memory headroom, unknown and changed quota fail closed
PASS clean inactive cache is available; dirty/writeback/active/unknown memory is never counted as free
```

跑完后这两个脚本的 SHA-256 与跑前一致，`git status` 对这两份文件为空。本机是 macOS，单测只断言 `linuxResources('/tmp').supported===false`，没有读 Linux cgroup。

## 哈希

| 对象 | SHA-256 | 字节 | Git blob |
| --- | --- | ---: | --- |
| storage-load-resources.ts | `fc88009736dd47df221b2ce4d765702ff7f17df42c4500b5e128de341838a0dd` | 7021 | `cfe703da40b948c988f1b71b9f225af46d9a59c5` |
| storage-load-resources.test.ts | `d7883db136d5daf53961454b2db3786207e13d304ef0d3a9b922869b5fe45c63` | 5552 | `8aeffd055769c09581aa40eae0c32b2947c1aa8b` |
| D/CACHE-PROBE-RAW.json | `f14e1482b01f3b944dbcf9d055e6e3f17f9e76a601ea443e5945713250346bad` | 6671 | — |
| D/CACHE-PROBE-REPLAY.json | `dda0897ce2349551e5462ccee6b08f5de71a71894c8b0046e4233025f5dffd42` | 3854 | — |

## 未验

未重新占用页面，未重跑探针，未读在跑进程已装入的模块，未 SSH，未核远程 1 小时单元、NAS 全账、72h 排空、ACK 延迟或完整 T5。未把 fresh 600k、这次探针、回放或加速单测写成 24h。主机恰好 `0.2`、磁盘恰好 `4.5GiB` 没有单独的新用例；比较符和失败用例仍在，实跑覆盖了 `0.199` 与 `1` 字节磁盘。`dirty=0` 且 `inactive_file>current` 时两个公式都会把全部 current 当成可回收；四条真实样本没有这种形态，不另立新门。
