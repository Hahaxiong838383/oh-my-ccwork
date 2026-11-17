# T5 1h 断线恢复独立只读核验

结论：**PASS_SCOPED**。从两份原始 JSON 重算后，没有差异。

范围只包括这次小负载传输断线：业务 `b1ce23aecf2a699c55f81942c76ee05ca48fa5f1`，生产者 `4aed8139ea665a529d94d29e8e9c677bff549a34`，冻结 harness `636da4e4bb056b2b55aaebd9200df720b1bfb8641212c62de08d6ad58e7b4088`。50 个身份、74 轮、3700 条接受、23 个包、3178684 字节、单调钟 3600 秒内 120 次 TCP 拒绝、恢复 161715 ms、恢复后 source pending 为 0、751 次生产 guard 全部 ready。`full_t5_pass` 在生产者、恢复对象和 NAS 结果里都是 false。

本结论不覆盖 259200 条 72h 全模型、成熟混合负载、24h soak、voice AB，也不构成生产通过。单独的 Linux 调度 smoke（0.25 CPU，ACK 慢）没有读入，不计入这次 1h。

## 做法

私有脚本只读解析两份证据，逐条重算 HTTP、载荷字节、SHA-256、收据、record id、uptime 字面量和 guard。没有执行 `verify-outage.py`（该脚本会改写 `OUTAGE-VERIFIED.json`），没有 SSH，没有改源码、生产或正在运行的任务，也没有把结论绑到当前主树 HEAD。`OUTAGE-VERIFIED.json` 的计数字段与这次重算一致，只作为交叉核对。

- 云证据 sha256 `95155d0b24fbc0ff542ee6e4751d40951d929c861d38645a1882cb674d6e34cc`
- NAS 证据 sha256 `3506b2b72ae22bc672b190fc45e283124dd74cbbca22d4d1020cb7b3d226a87f`
- 脚本 sha256 `00f387c8d7c19282462f1db50b38b78f44d9639c69f925019ced761cc4e8cf0a`
- 运行日志 sha256 `adc02df303e6c8e752da688d4f51d7bd80bdd03d490f766b77f0ff04294ba5a0`（45 项断言全部成立，退出码 0）
- 证据内 gate pin 与本地 `outage-gate.py` 同为 `e843127d662f895058906d715a57125d93ace111f7d1b213ebc9f0f09dfb8c9f`
- 证据内 runner pin 与本地 `outage-nas-runner.py` 同为 `7483ef7c8b4d9fb0c3ebc87d8d8e1dcad4b144748f6ea9fe13f94597c7585f84`

## 重算结果

HTTP 3700 行，snapshot_id 唯一，恰好覆盖 50 个 actor 的 round 0..73，状态全部是 200 / accepted / ok。

23 个包的 archive_id 与云侧 23 个 `complete` 批次、23 张收据对齐。原始载荷字节、manifest 字节合计、按排序键重编码的 envelope 字节都是 3178684。每包 SHA-256、长度和 record_count 与两侧收据相同。3700 条记录的账号、`epoch=1`、`stardust=null`、body_hash 和 SN 与 HTTP 的 actor/round 一致。record_id 恰好是 1..3700。50 条 current 都是 round 73，且 `stardust` 为 null。

门的原始 uptime 字面量 `11030197.130000001 - 11026597.130000001 = 3600.000000000`。120 条 blocked 尝试全部是 `list`、exit 255，blocked 标志与 `uptime < until` 一致，耗时 7–13 ms（中位 7 ms），相邻间隔 30.02–30.09 s。其后 75 条 forward 全部 exit 0，uptime 都不早于 until，耗时 811–1372 ms。runner 里的 ConnectTimeout 是 8 秒，对不上这 120 次的耗时。门脚本把阻断中的 ssh 指到 `127.0.0.1` 上未 listen 的端口 48191。

恢复用第一条 forward 的 `at_ms` 1794936475761 到 `recovery.finished_at_ms` 1794936637476，差 161715。全部收据的 `verified_at_ms` 都不早于这条 forward。墙钟截止点和第一条 forward 之前各有 72 条 progress，`last_ack_ms` 为 null，且当时 `pending_records` 等于 `accepted`。

`recovery.source_pending` 和最终 stats 的 `pending_records`、`pending_bytes`、`reserved_bytes` 都是 0。生产者自己的 `PRODUCER-RESULT` 在 1794936576078 结束时 `pending_records` 仍是 3150，那是恢复排空前的快照。恢复对象在 1794936637476 写下 pending 0。NAS runner 在 1794936730752 以 exit 0 结束，`verified_packages` 为 23，`elapsed_uptime_s` 为 3860.74。

源停止记录是 `Result=success`、`ExecMainStatus=0`、`ActiveState=inactive`，`guard_stop` 为 null。751 条 guard 的 `production_ready` 全为 true。最小 `free_bytes` 是 5574287360，fixture 峰值是 9495938，预算失败数是 0。

## 未再验证的边界

- 没有 SSH，没有在源或 NAS 上重看 systemctl、监听套接字或抓包。停止成功来自证据里已经写下的 systemd show 和 NAS `RESULT.exit=0`。
- `transport_attempts` 没有 stderr，也没有目标地址。证据 JSON 里没有 `Connection refused` 这行字。
- 没有在远端复哈希当时运行的 gate/runner。只核对了证据 pin 和 D 里的本地副本。`outage-cloud-driver.py` 只在本地做了哈希，它不是两份证据 JSON 里的字段；harness sha256 是云证据里的 pin。
- 候选里的 `production_changed=false` 没有用生产树 diff 再证一次。
- systemd show 里的 `CPUUsageNSec` 和 `MemoryPeak` 是 `[not set]`。
- 0.25 CPU 的 Linux 调度 smoke 不在本次输入里。
