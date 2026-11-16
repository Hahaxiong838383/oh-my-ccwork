# T2 独立验收：PRnas 归档通道与断线续传

**结论：PASS_SCOPED**

候选 `845d8cfa3e1d3a24d872a611d81e9e90467768c8`，parent `bef0dea904bc813a9a141b92455e57c898726c16`。本轮只打通隔离目录上的 PRnas 归档与断线续传。完整 T2（定时器、日/周轮换、成熟库备份预算、keep2/未确认钉住接入生产备份路径）未收口。未登录远程 NAS/云端。未改源码、分支、生产、NAS、凭据。未另委派。

模型：Grok 4.6。角色：独立验收。

## 候选与范围

`git rev-parse 845d8cfa` 得到完整 SHA 如上。七文件相对 parent：

| 文件 | 作用 |
|---|---|
| `apps/server/package.json` | 只增加 `test:archive` |
| `scripts/storage-archive.py` | 不可变 spool + 受限 SSH gateway（list/meta/read/ack） |
| `scripts/storage-archive.test.py` | 协议/路径/ACK/锁本地测试 |
| `scripts/storage-nas-pull.sh` | NAS 单包拉取：mkdir 锁、按偏移 SSH read、finalize 后再 ack |
| `scripts/storage-nas-verify.mjs` | 本地 SHA/bytes/SQLite 行数/fsync/原子改名 |
| `scripts/storage-nas-verify.test.mjs` | NAS 校验负例 |
| `docs/prnas-storage-50/t2/IMPLEMENTATION.md` | 本切片边界说明 |

`src/`、页面、`capacity.ts`、`policy.ts`、`analytics-backup.py`、维护定时器与 parent `bef0dea9` 无差异。生产应用本轮未改。`archive_enabled` 与四副本公式不在本切片。

审查窗口内工作区后来出现 16 个未跟踪 `docs/prnas-storage-50/t2/*` 副本（不在候选七文件内）。本报告不采用那些文件的结论，也未增删它们。候选七文件相对 `845d8cfa` 工作区内容无 diff。

## 本机命令（Node 24）

环境：`/Users/fu-121/.local/node-v24/bin/node` = v24.19.0，`python3` = 3.12.2。在 `apps/server` 执行。

| 命令 | 退出码 | 结果 | 日志 SHA256 |
|---|---|---|---|
| `npm run test:archive` | 0 | Python 7 tests OK；NAS verify PASS | `3cf600cb2edbd31c282c01361c73a0b92eaf81c735d3c9dab7bb90947edebd67` |
| `python3 scripts/analytics-backup.test.py` | 0 | 4 tests OK | `2ea5d6531bdc2cd7e32723c2bdb3f16e75e6a51a076f87a91cede9b1b5eb5706` |
| 私有 `extra-archive.test.py` | 0 | 8 tests OK | `9eb1d067734338527e7b7ecba51f5ac01d52f08fcb763eb16e9afc41da4a8dad` |
| 私有 `extra-nas-verify.test.mjs` | 0 | PASS | `a28ec8719ccc3da1fc3c9f10402dc11b7bbe165e9046327f18c77ac08933951d` |
| 私有 `extra-pull.sh`（假 SSH，无网络） | 0 | PASS | `17c82aaf0243c808d021e452b0a4a4cdfc13c29d81cf96776ff57b5f1bc07045` |

负例在 `/Users/fu-121/.local/state/p003-prnas-t2-20261116/grok-negatives/`，未改仓库源码。覆盖：gateway 注入/空命令/大小写动词、软链接根与 payload、空文件、发布中 fsync 失败不可见、未发布 id、偏移类型、源在拷贝中变更、坏前缀后续传被校验拒绝并隔离后从 0 重来、改名前 fsync 失败可恢复、表行数总和谎报、非法表名、mkdir 忙退出 3、ACK 丢失后 `resume_offset=total` 只补确认、杀死传输进程 exit 4 后按 4096 续传、SIGTERM 释放锁、SIGKILL 残锁 fail-closed 需受控清理。

## 提交人 NAS 证据一致性（未亲自实测）

只核对 `/Users/fu-121/.local/state/p003-prnas-t2-20261116` 已落盘 JSON，不宣称亲自 NAS 实测。100MiB 合成数据不等于生产全量或 50 台负载。

| 文件 | SHA256 | 一致性 |
|---|---|---|
| FIXTURE-RESULT.json | `cef0acd605afa1986acf865b7c4708c72005609bbb2f3b6d71895038a5fef552` | 大包 105811968 字节、`record_count=3200`（1600+1600）、WAL 已提交行进快照、备份后新行排除 |
| SMALL-PULL.json | `d082a33dde6718ecb495ffb5ae522e000367336864719d0a9dafa8ba8d067851` | 64KiB `4d8829a6…` offset=0 后 ACK_STORED |
| LARGE-FIRST.json | `f2fadab11df7b3738de3740a41d0d92aa76cdb7c524179b4afb3e35a2771b907` | 约 13.5s 一次拉完。这是通路径，不能冒称断线 |
| INTERRUPT-REAL.json | `54aedf8e3034791359e540a2b807a48a3b0722f3d7c8c79da8bec94a7c46f733` | `COMPLETED_BEFORE_INJECTION`，与 LARGE-FIRST 过快完成相符 |
| INTERRUPT-PASS.json | `d5474ca64d9f1422e54de469f2ba8bdf5134cf0a57818adcfb1995dce112b47a` | 真实 `process=ssh` pid 20174；`after_bytes=34406400`；传输 exit 4；并发第二任务 exit 3 |
| AFTER-INTERRUPT-SOURCE.json | `211c6543a6868c24ecda1885adb553d9b133355bdac89b09507add4e7b15358b` | 源仍在、无 ACK；id 换成 `c38eaf70…`，哈希仍是大包 `fdfe8c7f…` |
| RESUME-PASS.json | `39eae7849e4e1fb8f59513906279b5b2efc530ebf46b03bd886e3c0730430435` | `resume_offset=34406400` 对齐 after_bytes；105811968 收齐并 ACK |
| NAS-SQLITE-RESTORE.json | `3c9e90a3c6d0ec86a3607d9ac1bb950562246d3056f689019572f763012c8660` | integrity ok；1600 event + 1600 seen；样本 hash 一致；备份后行未混入；容器 Node sqlite 实验警告在 stderr |
| ACK-LOSS-PASS.json | `9db0383e3439bf51e70660d56ad7c83d2154505fb91f26246070ec66047180bc` | 丢确认后本地无 receipt；重跑 offset=65536 只补 ACK |
| CORRUPTION-REJECT.json | `66db0812415faefb202e8da38718e8f10f8079532ce897f5cb87802863a999d7` | 等长坏包 CHECKSUM；超长 PARTIAL_OVERSIZE |
| CORRUPTION-SOURCE-SAFE.json | `3aa3a18b02eeeffea34abe6f59afe2d3723de249463f40f660cec4778b9bbadb` | 拒绝后源仍在、无 receipt |
| CORRUPTION-RETRY-AND-GATEWAY.json | `79bfb994fef9c16bc2e5256ae0a87fec8d30ce259b1859fc1a61d095543a8a85` | 隔离后 offset=0 重拉成功；forbidden_command_exit=1 且 stdout_bytes=0 |

夹具脚本走现有 SQLite Backup API，不是拷贝活库主文件。传输是 SSH 偏移读取，不是 rsync append。这与 QNAP TS-X65、rsync 3.0.7、无 Python/flock/nohup 的预检记录一致。提交人记录云端 `authorized_keys` 增加受限公钥（`new_key_restricted: true`）；本验收未打开私钥、未复核线上 authorized_keys 正文。

## 协议与锁

云端 gateway 只接受 `list` / `meta <id>` / `read <id> <offset>` / `ack <id> <sha> <bytes> <count>`。路径、软链接、越界偏移、错误 ACK 失败关闭。确认不删除源。NAS 在 payload/目录 fsync 并改名之后才 ack；fsync 失败不发确认。

`storage-nas-pull.sh` 用 mkdir 锁。网络/SSH 失败和 INT/TERM/HUP 走 trap，锁释放。杀死传输 SSH 子进程：父进程 `wait` 后 exit 4 并清理锁，这是本轮断线续传路径，NAS 证据与本地负例都走到续传。SIGKILL/断电留下 `.pull.lockdir`：下一任务 exit 3，需先确认记录 PID 与同目录 SSH 已退出再人工拆锁。这是明确失败关闭，**不构成当前已授权目标的阻断**，也不是无人值守定时承诺。

## 明确未完成

- 生产归档定时器未启用
- 日 7 / 周 4 轮换未做
- 原备份器 60s/90s/120s 预算未改；100MiB 不能证明 90 天库
- 未确认包尚未接入现有 keep2 目录的钉住/跳过日备逻辑
- T3–T6、50 台、语音、生产库演练均未做
- 本结论不是合入、不是上线、不是开 198

阻断项：无。
