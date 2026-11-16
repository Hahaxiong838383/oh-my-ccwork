# T3 候选 74482851 独立验收

结论：不通过。固定提交 `74482851a914256591238a6cb8b9d66a1447cfbb`（基线 `ee876889647775f3c6c2bb540df7017f3571466f`）的 `npm run test:ark-archive` 为 25 通过 / 0 失败。同一提交的磁盘地板没有挡住已排队、尚未落成 spool 文件的副本。

测试树是该 SHA 的 `git archive`，目录 `/Users/fu-121/.local/state/p003-prnas-t3-20261116/audit-74482851`。Node `/Users/fu-121/.local/node-v24/bin/node`（v24.19.0）。`node_modules` 只读符号链接。业务工作树没有被本审计修改。

## 阻断

`src/ark/archive.ts:38` 的逻辑上限使用 `stats.reserved_bytes + 本行预留`。磁盘条件只比较 `freeBytes < reserveBytes + 本行预留`。`service.ts` 的 `reserveBytes` 是 4.5GiB，`freeBytes` 是数据库卷的 `statfs`。下一次接受只能看见数据库已经增长的页，看不见导出时才写出的 JSONL 与 payload。

复现：对归档副本里的 `ArkStore.accept` 注入 `reserveBytes=200000`、初始 `freeBytes=240000`，逻辑上限 8GiB。每接受一行后做 `wal_checkpoint(TRUNCATE)`，再按 db+wal+shm 的增长扣减 freeBytes。30 条真实关键变化全部接受，没有抛错。

| 量 | 字节 |
|---|---|
| 封套合计 | 23664 |
| 逻辑预留 | 163152 |
| 数据库增长 | 32768 |
| 接受后的 free | 207232 |
| 再写一份 spool 文件后的 free | 183568 |
| 地板 | 200000 |

穿地板 16432 字节。current.sequence 为 30，outbox 为 30。单行边界仍然正确：预留 5430 时，free 等于地板加预留则接受；少 1 字节则 `archive_buffer_full`，outbox 为 0，current 为空。

影响是背压偏晚。已提交历史还在库里。导出写文件时可以吃掉 4.5GiB 地板，然后导出失败，积压停在本地。探针在 `/Users/fu-121/.local/state/p003-prnas-t3-20261116/probes/disk-noise.mjs`。

## 已实测并通过

- 同事务：提交前 SIGKILL，current 与 outbox 一起回滚；提交后两者都在。duplicate 不增加历史。触发器让检查点插入失败时，current 回滚且事务关闭。
- 逻辑预算：差 1 字节拒绝且不留半截；等额接受。
- 5 分钟与噪声：299999ms 不留档，300000ms 留档。新 boot、新 sequence、经济字段不变时 outbox 仍为 1。随后 300 次资产变化使 outbox 变为 301，耗时 619ms。
- grant/epoch：换绑后旧身份读不到 current，旧封套保留。50 个合成身份的余额各自保留。GM、unknown、logical_day、null 与 0 会触发留档。
- 关闭开关：关闭后新关键变化只更新 current，旧 outbox 还在。导出器不读 `archive_enabled`，已有 outbox 会打成包；确认前 reserved 仍为 `3*(835+1024)=5577`。
- 崩溃：claim 提交前 SIGKILL（-9）不留 batch；claim 提交后留下 `claimed` 并恢复成同一个 3 行包；manifest 已写入、rename 前留下 `prepared` 并恢复成 1 个包。suite 覆盖 publish 返回后的 SIGKILL，以及清理函数抛错后 outbox 不删、再跑可以清完。
- ACK：错误 count、被改 envelope、错误 sha256 都不删 outbox。错误 sha 时 `payload.bin` 仍在。
- JSONL：真实导出包 `481df94d9f00447286f36eb8073e66f2`（835 字节，`format=ark_jsonl`，`format_version=1`，`lines=1`）经 NAS `finalize` 通过，文件 sha 一致。改 1 字节得到 `CHECKSUM_MISMATCH`。created+89 天不删；ACK 且 created+91 天才删。suite 覆盖未 ACK 的百天旧包保留，以及 437 个字段变体与线上 schema 一致。
- 批次与队列：512 行乘 2048 字节得到恰好 1048576 的包，多出的 2048 字节单独成包，发布 0.1266s。1001 行乘 512 字节分成 1000 与 1。21 个 600000 字节行第一轮只发布 20 个；ACK 一个之后的下一轮才补上第 21 个，带 payload 的 list 保持 20，没有包超过 1MiB。发布后、ACK 前，1001 行的 reserved_bytes 仍为 4612608。
- 差分范围：相对 ee876889 为 22 文件、+593/-18。路径里没有 `routes/telemetry.ts`、`routes/ark.ts`、`records-*`。没有做 360 全仓 merge 调查。

## 非阻断

`storage-ark-export.py` 的领取循环遇到 `bytes > 1MiB` 会抛 `archive_row_too_large`，后面的小行也保持未领取。探针用 1048577 与 512 两行复现，published 为 0。设备正文上限 16384，正常快照走不到这里。

## 测试统计

`npm run test:ark-archive`，cwd 为上述归档里的 `apps/server`。

| 文件 | 结果 |
|---|---|
| ark-archive.test.ts | 12 通过 / 0 失败，2526ms |
| ark-archive-schema.test.ts | 1 通过，内部 437 个比较，143ms |
| ark-archive-http.test.ts | 1 通过，397ms |
| storage-archive-control.test.ts | 1 通过，112ms |
| storage-ark-export.test.py | 7 通过 / 0 失败，4.004s |
| storage-ark-nas.test.mjs | 3 通过，436ms |

合计 25 通过 / 0 失败。类型检查没有重跑，不能写成全绿。

## 未验范围

- tsc，以及与基线相同的 12 个旧错误。
- 根上已经跑过的 `test:archive-complete`、`test:storage`、`test:ark`。
- 后台页面与 `test-analytics-admin-ui.cjs`。
- 真实 NAS、SSH、设备、生产配置、部署。
- 50 台混合、语音对照、T4 容量系数。
- fsync 与 DELETE 语句内部的 SIGKILL；多进程锁竞争时延。
- 把物理盘削到 4.5GiB 边缘。地板问题用策略回调注入 freeBytes 复现。
- 360 提交 `5d24359d` 的全仓冲突，以及旧 fixture 的 `STORAGE_CAPACITY_LIMIT`。
- 审计结束时工作树头是 `4ea6af5afb8fbd80133a7a48fbeea9565d135217`，中间还有 `11ef01ec` 与 `4ea6af5a`。这两个提交不在本次固定 SHA 结论里。当时工作树还有未提交的 t3 文档与夹具，不是本审计写入的。

机器可读副本：`/Users/fu-121/.local/state/p003-prnas-t3-20261116/REVIEW-CANDIDATE-GROK.json`。
