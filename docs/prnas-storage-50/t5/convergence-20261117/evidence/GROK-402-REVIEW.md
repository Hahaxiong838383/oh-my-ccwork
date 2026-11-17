# 新鲜 50×12000 混合负载独立审计

审查只读重算固定候选 `b1ce23aecf2a699c55f81942c76ee05ca48fa5f1` 的这一轮新鲜混合子项。解释器是 Python。没有改工作树、生产、设备，没有 SSH，没有重跑压测，没有再查云端数据库。

结论：**FRESH_50x12000_MIXED_RECOMPUTED**。

本文件只覆盖 50 设备 × 每设备 12000 事件的新鲜混合负载。成熟 90 天净清理、1 小时断线、24 小时浸泡、语音 AB、最终 600000 事件 NAS 还原，都不在这次证据里，也不能从本结论推出整项 T5 通过。

## 证据范围

输入是 `contention-full-evidence/fixture`、`contention-full-evidence/control`、`evidence/contention-full-bundle-verified.json` 的 23 个文件 SHA、`evidence/contention-full-summaries.json`、`evidence/600k-expected-summary.json`。`evidence/CONTENTION-FULL-VERIFIED.json` 只作为主13待核主张，对照放在重算之后。

捆绑包 23 个文件的 SHA-256 与字节数全部对上。`contention-full-evidence.tar.gz` SHA-256 `5fc4a63c5ff4418acfb699cbcdea8e6586a1c81417241d95eede70db93b1d229`，1856204 字节，与 `bundle_sha256` 相同。成员列表与清单相同。

## 固定候选与源码归档

工作树 HEAD `b1ce23aecf2a699c55f81942c76ee05ca48fa5f1`。`CANDIDATE.json`、`SOURCE-VERIFIED.json`、`FULL-START.json` 的候选都是这个提交。归档路径 `apps/server` 与 `snapshot-v1.example.json` 没有未提交改动。工作树另有 16 条 `docs/prnas-storage-50` 未提交文档；本审计没有改它们，也没有还原它们。`git archive` 取的是提交对象，不读这些文档。

本地 `git archive --format=tar.gz` 该提交的 `apps/server` 与 `snapshot-v1.example.json`，SHA-256 `2cea9894faeb9cdb604075353feb93a6d84a52054cd2735b50fff927625a5ea1`。这与 `CANDIDATE.json` 的 `archive_sha256` 相同。归档内 577 个文件的 SHA-256 与 `SOURCE-VERIFIED.json` 相同。

负载工具记录的 Node 是 v24.19.0。测试单元 `p003-t5-contention-50x12000-01` 的 `FULL-DONE.json` 为 `Result=success`、`ExecMainStatus=0`，`guard_stop` 为空，`client_exit` 为 0。

## 请求重算

按 `requests.jsonl` 的磁盘顺序，50 个 actor 各自从 offset 0、attempt 0 起步。每次 503 保持 offset 并把 attempt 加 1。每次 200 把 offset 加 200 并把 attempt 归零。最终每个 actor 的 offset 都是 12000，attempt 都回到 0。顺序断裂 0。

| 项 | 重算 |
| --- | --- |
| 尝试 | 10688 = HTTP 200 的 3000 次 + HTTP 503 的 7688 次 |
| 503 原因 | ANALYTICS_OVERLOADED 7134，ANALYTICS_WAL_PRESSURE 554 |
| 带过 503 的成功批 | 1858 |
| 200 ACK P95 / P99 | 247.1212499999965 / 603.44571 ms |
| 上项保留 3 位小数 | 247.121 / 603.446 ms |
| 含重试的单批时长 P95 / P99 / max | 65724.13926299993 / 109617.44435 / 199724.14884499996 ms |
| 完整上传 | 1166390 ms |

ACK 百分位按升序后的下标 `min(n-1, floor(n*p))` 取值，n=3000，不从尝试次数里剔除 503。含重试的单批时长取每条 HTTP 200 记录上的 `batch_elapsed_ms`。每条成功记录的 `batch_elapsed_ms` 都不小于该次 ACK 的 `ms`。

`requests.jsonl` 没有墙钟。完整上传 1166390 ms 来自负载客户端 `client-result.json` 的 `duration_ms`，与 `full-50x12000.log` 的 `seconds` 1166.39 一致。进度日志在 `started_ms` 之后 1162746 ms 时是 2998 批、10686 次尝试，下一条完成记录是 3000 批、10688 次尝试、failures 空。这个间隔落在进度采样的 20 秒窗口内。

## 3000 份 ACK 与 600000 个 ID

`completed.jsonl` 有 3000 条 ACK。每条 `ok`，200 个 ID，`rejected` 为空，`duplicated_event_ids` 为空。ID 集合等于 `load-t5-17-1794929362353-<actor>-<0..11999>`，共 600000 个唯一 ID，交叉重复 0。接受 600000，重复 0，拒收 0。HTTP 200 的 `(actor, offset)` 序列与 completed 相同。

## 小表与工具记录的逐 ID 匹配

停机库小表用的是已经导出的 `evidence/contention-full-summaries.json`。这次没有再连生产库，也没有再导出。

| 表 | 重算 |
| --- | --- |
| analytics_day | occurred 600000，received 600000，两维摘要与 `600k-expected-summary.json` 相同，cutoff 等于 `last_received` |
| analytics_device_day | 100 行 = 两维各 50 台；列与摘要的 event_count 都是 12000；sessions 1；unique_reward_instances 1 |
| analytics_rollup_source / device_stage | 各 100 行，设备键与 device_day 相同 |
| analytics_rollup_distinct | 200 行 |
| analytics_dirty_day / rollup_retry | 0 行 |
| analytics_meta | last_rollup_status=complete，failed_days=0，remaining_dirty_days=0；last_rollup_partial_ms 仍保留 1794930261259 |

distinct 分项：occurred:reward 50, occurred:session 50, received:reward 50, received:session 50。

`RESULT.json` 的 `database_canonical_matches` 与 `database_seen_matches` 都是 600000，`counts` 为 events 600000、seen 600000、batches 3000，跑前为 0。这些字段是 `storage-capacity-load.ts` 在那次运行里写下的原始输出。本审计核对的是这份输出，以及它和 ACK ID、小表总数是否一致。本审计没有自己打开云端数据库做逐 ID 连接。小表只有汇总行，没有事件 ID，因此小表一致不能代替那次逐 ID 匹配。`FULL-DONE.json` 内嵌的 integrity、acks、maintenance、dirty_days 与 fixture 的 `RESULT.json` 相同。

## 维护 partial 被保留，最终 dirty 0

| 文件 | partial | remaining_dirty_days | rebuilt_days | failed_days |
| --- | --- | --- | --- | --- |
| `maintenance-1794929362534.stdout` | false | 0 | 0 | 0 |
| `maintenance-1794929660535.stdout` | true | 2 | 0 | 2 |
| `maintenance-1794929960535.stdout` | true | 1 | 1 | 1 |
| `maintenance-1794930260534.stdout` | true | 2 | 0 | 2 |
| `maintenance-1794930528756.stdout` | false | 0 | 2 | 0 |

五份 stdout 都还在，正文与 `RESULT.maintenance` 逐份相同，退出码都是 0。中间三份是 partial，dirty 天数分别为 2、1、2。最后一份 partial 为 false，重建 2 天，remaining_dirty_days 为 0。`RESULT.dirty_days` 为 0。meta 里仍留着中间那次 partial 的时间戳。

## 早期备份与 ready

备份 stdout 的 `analytics_event` 与 `analytics_event_seen` 都是 200，`record_count` 1069，`state` 为 published，`last_offsite_backup_ms` 为 null。当时 dirty_day 行数是 2。这是负载早期的本地备份发布。它不是最终 600000 事件的 NAS 还原。`backup_exit` 0 只说明这次早期备份进程退出码是 0。

守护 `full-guard.jsonl` 有 252 条，`production_ready` 全部为 true，最小 `free_bytes` 为 5524566016，高于 5GiB 底线 5368709120。导出的跑后 `production_ready` 为 true。同一次导出里能看到进程名 p003-voice, kidshub-voice, p003-analytics。这里的 ready 是生产服务就绪采样。它不是语音 AB 结果。

## 主13主张对照

`evidence/CONTENTION-FULL-VERIFIED.json` 里的 accepted 600000、dup/rej 0、attempts 10688、状态 200=3000 与 503=7688、ACK 精确 P95/P99、3 位小数 247.121/603.446、完整上传 1166390 ms、含重试单批 P95/P99/max、守护 252 与最小空闲字节、候选和 bundle SHA，与上面的重算相同。该文件不是本结论的依据。

## 日志 SHA-256

| 路径 | 字节 | SHA-256 |
| --- | --- | --- |
| `fixture/maintenance-1794929362534.stdout` | 302 | `247934901c985503a9bac6d240428e6d3051c283474073cd3cb69ae855701c6e` |
| `fixture/backup.stderr` | 60 | `d7c90394c67572d508503732139fd62198ec38b5cbb50ab7cce6cf5f7151d887` |
| `fixture/backup.stdout` | 1023 | `da67559c065afb5514eaaf612e3983830efd5f54cb31f32c78b2ea96b58b0369` |
| `fixture/client-result.json` | 5110 | `f68579680adf23ca4708e3e5f1f050a98e0c2f99dc35ac104448abfc875393b7` |
| `fixture/maintenance-1794929660535.stdout` | 440 | `2ed651fd6745f59a9de4a96bd03fd4dfad6c73fb04745ce0d3fef129742034b8` |
| `fixture/completed.jsonl` | 21454780 | `fd18de93016e7117bfc5bd677daa20e65816b4a1a53d5a7132dcf1f5419ba764` |
| `fixture/maintenance-1794929960535.stdout` | 369 | `b4db33d779c2beed5efacfd8886cceeda8c8759bb0b39019a7052ece297bbda1` |
| `fixture/maintenance-1794930260534.stdout` | 440 | `25dc592157aabd333b3905789d7176a42aa59587e12c1f28db12530ecf7d447f` |
| `fixture/client.stdout` | 4567 | `509f91f897af396e1428305a0cb4f4134ec2008b1e036b78a16e6b5f74d85e99` |
| `fixture/maintenance-1794930528756.stdout` | 302 | `d9adfded0fbcf74269b155574a1db49d6045e52aa883ae92e2d43710cc9edb34` |
| `fixture/config.json` | 275 | `ce2413ea3510622dcdecfccda6e8fe4d2b97b03e05f64f9475700251add0dac4` |
| `fixture/health.jsonl` | 1508780 | `2177d77b929a506f4d8ef2e680e9f6d07ca3486ff659cefc8a4e6b98ae246d6a` |
| `fixture/RESULT.json` | 475727 | `22a0fefc35e51e2b9ddff31f85b7a842663590d822675a8b5f66c3ab2e6fb675` |
| `fixture/requests.jsonl` | 1642567 | `dea01fa13bbbe8f68cf9bee6c6146bf472fe098a3b4c5f9b9a26f4f4fbfeadd4` |
| `fixture/resources.jsonl` | 579275 | `f2e0e51ccd16bdc31a7f4424776ce3a9b2e9e45e03aed901f4b4039d29ab5781` |
| `control/FULL-DONE.json` | 509972 | `23c71df4ce8340f99bd832c0fbc22c178b5153f0363cbdeec8413790303db148` |
| `control/FULL-START.json` | 1273 | `e1d83c24b3f113eb1dc2f438f55ce304fafb268a62bddf0051676f4f9f807c08` |
| `control/SOURCE-VERIFIED.json` | 84499 | `db4fa0e2d4f42b7898a85c40573f37b5146c48947b2991e906a85e0fc2a34d4e` |
| `control/TEST-SPACE-RECLAIMED.json` | 1093 | `23396dc1391cd7d042dd95156fe1c25451b3915cbfcb9af8d3d2cc3759499010` |
| `control/CANDIDATE.json` | 143 | `da31a31f33f8599cbcf3e46508260f2e7eccb7361514a7deb2e99f353b9314b9` |
| `control/full-guard.jsonl` | 19404 | `0e07ba3f3a5c4e1670a485f2b0c365498c9ca8c7dad090632c968ae5eaa7df29` |
| `control/full-50x12000.log` | 374 | `f525f476659d396ab413884e16da568f756b74d3afc89a29652f27915948f18e` |
| `control/full-driver.log` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

证据文件：

- `evidence/contention-full-bundle-verified.json` `31b4cfeade40ac9c843d075358dda18b3711534990c8c147becde9a4185e0534` 
- `evidence/contention-full-summaries.json` `6a383d9d4788d1a3f8a1e749562ea1bfa260e8464eb18983906b80bbaa70a3b6` 
- `evidence/600k-expected-summary.json` `8b3c3147155cbe4152986633bbc937fc9e597e3b7dc99cbe835a243440863cc2` 
- `evidence/CONTENTION-FULL-VERIFIED.json` `fdefe18e6d22e71c6c66a843a76a289a6fc5d3ce8475040d23a6cd8226196ea3` （主13主张，非通过依据）
- `contention-full-evidence.tar.gz` `5fc4a63c5ff4418acfb699cbcdea8e6586a1c81417241d95eede70db93b1d229` 

## 阻断

无。23 份日志 SHA、请求顺序、503 重试、ACK 百分位、3000 份 ACK、600000 唯一 ID、小表、维护中间态、守护底线和源码归档都与上面的重算一致。

## 本子项之外

成熟 90 天、1 小时断线、24 小时浸泡、语音 AB、最终 NAS 还原没有在这批证据里重跑或重算。
