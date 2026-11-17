# Grok 独立复核：T5 首请求与维护冷读

日期：2026-11-17。只读主树 `bbf40a4843d00579f6cfc5cfdcb14762c78ed373`。源码相对 `65c86916e1e6a64352ec75d3c2b6eebb364e649a` 的 `apps/server` diff 为空。本目录是私有归档，没有改原树、没有 SSH、没有部署、没有改门槛。

## 结论

T5 仍未通过。A07、A08、A09、A14 都不能标通过。这一轮没有可合入的最小补丁。

查询稳态已经落在预先的百分位余量里：1000 次里 p99 是 50.060ms，低于 120ms 内部截止 20ms 以上。脚本仍失败，因为首请求这一次没赶上。reader 在 `app.fetch` 内用了 137.420ms，客户端 155.528ms 时 body 未完整。服务端比 120ms 多 17.420ms。现有日志没有这一次的分阶段 `read_bytes`，不能把这 17ms 记到某一条可删 SQL。

维护失败在冷读吞吐，不在漏索引，也不在 JSON 算错。同一覆盖索引上，冷读 30.012 秒只走完 442624/600000 行，CPU 3.091 秒，磁盘读 155459584 字节。缓存命中后再解析 600000 行是 2.390 秒、CPU 2.405 秒、磁盘增量为 0。已给出的窄投影不减少叶子字节，不能把冷读收进 30 秒。不建议合入 `not-applied-narrow.patch`。

## 门槛裁决

数字来自 `docs/prnas-storage-50/t5/fixed-query-cold-io-20261117/` 的 RESULT、query-result、query-failure-and-scan、maintenance-after-scan，对照计划 `docs/superpowers/plans/2026-11-16-p003-prnas-50-devices.md`。

| 门 | 这次能证实的 | 裁决 |
|---|---|---|
| A07 接收延迟 | 成功 ACK 的 p95 是 525.924ms，p99 是 1738.339ms。账本只把 HTTP 200 放进百分位，6839 次 503 另计，没有拿失败样本去拉低 p95。成功样本本身仍超过 500ms。600000 条 1350.168 秒排空，那是 A06 的两小时子项，不是 A07。 | 失败 |
| A08 维护净能力 | 不是 90 天全索引夹具。单日 600000 fact 的冷维度在 30 秒内扫不完。剖析之后 occurred 因页面已热而重建成功，received 仍 `budget_exceeded`，dirty 从 2 到 1，`ok=false`。裁剪只看到随后 1 个 chunk、21.8ms，不是规模化锁 p99。 | 失败 |
| A09 Ark 查询 | p99 50.060ms，相对 120ms 的余量成立；`invalid_facts=0`。`history_transport_failures=1`，自检 `pass=false`。没有超时注入，也没有和上传、备份、维护重叠。 | 百分位这一句达到，整门失败 |
| A14 资源与耐久 | 没有 24 小时运行。当前空闲 8946868224 字节，多于 4 GiB+512 MiB 的预留数字，所以不能把“预留已经没了”写成事实。40 GiB 系统盘放不下 44871368704 字节的成熟夹具。 | 失败 |

A09 相对更早的 2 次超时是变少，不是变多。预先脚本要求零次传输失败，不能改写成通过。

## 首请求里哪些工作不在这 137ms 里

`storage-ark-query-load.ts` 的 reader 先 `new AnalyticsStore`，再 listen，然后才给 `app.fetch` 计时。因此下面这些不在 137.420ms 里：进程启动、tsx 装载、`journal_mode=WAL`、建表语句、64 MiB `cache_size` 的设置。

计时内的路径是：内部 token 比较、小 body、zod、`ark.grant()`、`readArkHistory`。`grant()` 会先跑 `settings()`，其中有一条 `SELECT sn FROM ark_grant ORDER BY sn`。50 行授权不会成为 17ms 的冷 IO；探针仍把它单独计时，避免靠猜。

`readArkHistory` 固定做三件事，都是结果语义的一部分，不是重复查询：

1. evidence：6 类事件加 GM 的 `json_extract` 过滤，上限 513。
2. assets：钱包、库存、补签卡，按发生时间排序，上限 513。
3. daily：当日进度和发奖，上限 513。生产代码只在当天有正常日标记、且没有 GM 日时才跑第 3 条。这条合成负载的目录里有 `logical_day_changed`，正常路径会跑到。

三条都 `LEFT JOIN analytics_batch`，只为读取 `client_json` 里的 `content_version`。本地小库上的计划形态是：事件侧 `USING COVERING INDEX`，batch 侧主钥查找，再加 `USE TEMP B-TREE FOR ORDER BY`。这只说明计划形状，不说明云端耗时。

目录有 57 个事件，每设备 12000 条、按目录轮转的话，evidence / assets / daily 大约是 1263 / 632 / 421 行。样本 properties 只有 32 到 243 字节。这是生成器估算，不是云端行数。真正行数要等探针。

不能据此删 SQL：

- 删 daily 或去掉 batch 连接会改变历史结果。`content_version` 有现成测试。
- 前一份索引审计量过 schema 查找约 0.08ms。这次没有重跑那 67 项，也不把它算成我的新实验。
- 稳态 p99 已经 50ms，说明三查询加 JSON 在页面热的时候放得进预算。多出来的时间只出现在进程的第一次请求。其他设备的第一次触摸也落在 p99 以内，所以不是“每个设备冷读约 1MB 就必然超过 120ms”。
- 全运行的 cgroup 节流增量约 0.55 秒，没有按请求拆开，不能单独解释这一次多出的 87ms。

`invalid_facts=0` 也不能证明历史扫描算出了那 50 个余额。加载器把所有事件的 `occurred_at_ms` 设成同一个 `started`，钱包样本的 `after` 是 20；快照用更晚的 `captured_at_ms`，余额是 `100+actor`。`chooseAsset` 在快照时间不早于历史时间时采用快照。这次相等检查可以由快照满足。传输成功只证明 HTTP 完成。

所以：没有一条已证实、可删除、且能单独把 137ms 打到 120ms 以下的同步 SQL。先做分阶段探针。在探针给出 `read_bytes` 之前，不写补丁。

## 维护：窄投影没有冷读收益

`t5_experiment_cover` 的叶子包含 `semantic_json`。三段计划都是 `USING COVERING INDEX t5_experiment_cover`。覆盖索引按整叶读取，SELECT 少列不会让 SQLite 少读叶子里的 JSON。

| 段 | 行 | 墙钟 | CPU | 新的 read_bytes | 字节/行 |
|---|---:|---:|---:|---:|---:|
| full，冷，30 秒截断 | 442624 | 30.012s | 3.091s | 155459584 | 351.2 |
| narrow，紧接 full | 600000 | 11.729s | 2.311s | 56029184 | 未缓存尾部 356.0 |
| parse，页面已热 | 600000 | 2.390s | 2.405s | 0 | 不适用 |

未缓存尾部是 157376 行。narrow 新读的 56029184 字节约为 356 字节/行，和 full 的 351 字节/行相差约 1.4%。这是在读 full 没扫到的尾部，不是列投影变瘦。按 full 的速度，600000 行要 40.68 秒、约 210.7MB。30 秒内读完需要约 7.02 MB/s；实测 5.18 MB/s，大约差 26%。热路径 CPU 只有 2.4 秒，30 秒预算在 CPU 上有余量。

本地快盘 A/B 的墙钟 25960ms 到 22718ms、CPU 约少 12%，摘要 SHA 相同。那是热 CPU，不是这次云端冷读。合入它不改变 30 秒门槛。

剖析本身把 occurred 的页面读热了。随后完整维护里 occurred 成功、received 仍超时，不能当成窄投影或代码优化的对照。

汇总必须读每行 `semantic_json`（GM、命令失败、奖励实例）。在不改汇总定义、不建新增量水位的前提下，没有更小的读取集合。增量汇总是另一套系统，这次不提案。

## 软件能做的，和存储才能碰的

软件已经做完、且证据支持留在原地的：

- 历史查询走三份部分覆盖索引，旧库回落到原索引。生产启动不建这些索引。
- 维护走覆盖索引的有序范围扫描，超预算回滚并保留 dirty。热扫描远低于 30 秒。
- 查询 p99 已低于 100ms。不放宽 120ms、500ms、30 秒或零传输失败。

软件这次不能证实的：

- 删某条 SQL 或改 SELECT 列，使云端首请求低于 120ms。
- 用窄投影或任何不减少叶子字节的改动，使 600000 行冷读低于 30 秒。

存储边界，两件不要并成一件：

- 容量：整块盘 42949672960 字节，空闲 8946868224 字节。成熟夹具 44871368704 字节比整盘还大。这不是清理或缩小夹具能假装通过的。500 GiB 没有购买授权，本复核也不把“买盘”写成已经解决。
- 吞吐：这台机器只有系统盘。公开的 `ecs.e-c1m2.large` 规格表是 2 vCPU / 4 GiB，云盘基础 IOPS 8000、基础带宽 0.4 Gbit/s、无突发。那是规格表，不是这次测量。这次约 1265 个 4KB 页/秒、5.18 MB/s，低于该表的基础值。一次 30 秒样本分不出磁盘等级、页布局、宿主共享和调度各占多少，不能写成阿里云故障。更大的盘也不自动等于这次扫描变快；容量和 IOPS 仍要分开复测。

查询任务的 unit 使用了 `IOWeight=20`。这是相对权重，不是硬顶。维护剖析那次的 unit 属性没有出现在已保存 JSON 里，不能把 5.18 MB/s 归到这个权重。

## 云端探针

脚本：`/Users/fu-121/.local/state/p003-prnas-t5-20261117/grok-next-review/profile-first-request.mjs`

SHA256：`bc4c4b5d8776726de3da56c4bf9b58b8fe557f37e24d912f248febca60c421dc`

只复制这个文件到隔离目录。停掉该隔离库的写入方后再跑。不要对生产库、不要 `drop_caches`、不要跑维护。

```bash
systemd-run --unit=p003-t5-grok-next-profile --collect \
  --property=CPUQuota=100% --property=MemoryMax=768M --property=Nice=15 \
  --property=IOWeight=20 --property=RuntimeMaxSec=90 \
  --working-directory=/opt/p003/archive-t5-20261117 \
  /opt/p003/server/.runtime/node-v24.19.0-linux-x64/bin/node --experimental-sqlite \
  profile-first-request.mjs \
  /opt/p003/archive-t5-20261117/p003-t5-50x12000-cover01/analytics.db
```

它以只读方式打开数据库，设置 `query_only`，拒绝路径里没有 `p003-t5-`、含 `/server/data`、或不是已规范化 `analytics.db` 的目标。页数低于 100000 时直接退出，避免打错库。默认时钟是运行当时。若已经离开 2026-11-17（CST），加上 `T5_PROFILE_NOW_MS=1794931199000`，否则窗口可能落空，时间为 0 行，不能拿来解释 137ms。

阶段顺序：启动期 schema 计数（不计入请求）、然后 `request_cold` 的授权查找、BEGIN、索引名、evidence、assets、这两段的 JSON.parse、daily、daily 的 parse、COMMIT。接着同一设备再跑一遍 `warm_repeat`，再跑 actor 1 的 `second_device`。最后才 `EXPLAIN QUERY PLAN`。每段记录墙钟、CPU、以及 Linux 上的 `/proc/self/io` 与缺页。只读连接可能触碰 `-shm`；`analytics.db` 或 `-wal` 的大小变化会使退出码为 3。

预先规定怎么读结果，避免测完再改口：

1. `request_cold` 三段查询的行数和为 0：作废，先改时钟重跑。
2. `request_cold_read_bytes` 小于 4096：这次没有观察到冷磁盘读。CPU 拆分仍可看，但不能解释 137ms 的磁盘假设。
3. 某一阶段同时占冷读字节的大多数、又占 `request_cold_ms` 的大多数，才是首请求的主要阶段。
4. `warm_repeat` 和 `second_device` 只用来对照，不算出优化收益，也不构成预热方案。
5. 只有在 `read_bytes` 明显大于 0、且 `request_cold_ms` 仍超过 120、并且多出来的时间集中在一个不改变历史 JSON 的阶段时，才值得再谈最小补丁。batch 连接是唯一还留着的候选方向；未测到字节之前不改。
6. 本脚本不测量维护，不重新扫描 60 万 fact。

## 本地自测的限度

`profile-selftest.mjs` 在临时小库上退出码 0。四行事件，数据库字节未变，`query_only` 下的建表被拒绝，错误路径退出码 2。三份计划都是覆盖索引，加 batch 主钥左连接，加临时排序。Node v24.19.0，本机是 darwin，没有 `/proc/self/io`。这只证明脚本可运行且不改文件。本地耗时不是云端 137ms 或 30 秒的证据。

## 没有做的事

没有合入或另写补丁。没有重跑 50×12000、1000 次 HTTP、67 项 Ark 测试或云端维护。没有购买或建议立即购买磁盘。没有接触会话 373 的树。

证据拆分使用了 Scientific Agent Skills 的评估顺序。Kassis, T., Agarwal, V., He, Y., Patel, D., & Brueckner, A. M. (2026). Scientific Agent Skills: A Library of Procedural Knowledge for Research Agents. arXiv:2609.00065. https://doi.org/10.48550/arXiv.2609.00065
