# T5 24h 准备审计 — 证据摘要

审计：只读。产物仅本目录。仓库工作区未被本审计修改或 commit。

## 审计环境

| 项 | 值 |
|---|---|
| 开工 HEAD | `7e695c80ad959131afbc5cc54ef800c9cef946f6` |
| 开工 porcelain | 空 |
| 分支 | `codex/p003-prnas-storage-50-20261116` |
| 收尾 HEAD | 同（仍 7e695c80） |
| 收尾他人脏文件 | `STATUS.md` 已改；`T5-T6-READY-20261117.md`、`t5/PREPARATION-360-20261117.json` 未跟踪。本审计未写入 |
| COVER01 候选 | `a3f2b982`（HEAD 祖先；harness 相关文件 diff 空） |
| 云端 unit | `p003-t5-50x6000-cover01`；`RuntimeMaxSec=4200`；`MemoryMax=768M`；`CPUQuota=50%` |
| 本轮云端负载 | 无 |

## 源文件 SHA-256（HEAD blob）

| 路径 | sha256 |
|---|---|
| `2-Projects/P003GameDemo20260513/apps/server/scripts/storage-capacity-load.ts` | `0ede4aa1925df55f550f4b9a0b64076e0eab36622645d804e7b1233e8e523044` |
| `2-Projects/P003GameDemo20260513/apps/server/src/analytics/index.ts` | `0a81e22018c7122d44209108f502c4bedd956e038e60e3ae79b6b4df86557643` |
| `docs/prnas-storage-50/t5/STATUS.md`（开工已跟踪版本） | `b5c05983fba1693cffadbcb48709c4558d3b49882260db4457390d8afc36abc6` |
| `docs/prnas-storage-50/t5/LOAD-50x6000-COVER01.json` | `830b97b5af70522100f7b754dec6c052f53fa5a1234da3fec4b17fd24a3cbf95` |
| `docs/prnas-storage-50/t5/LOAD-50x6000-01.json` | `d781927cac571229f708e497649461fdb6f490eaf1d8d07172f75e6ab796c201` |
| `docs/superpowers/plans/2026-11-16-p003-prnas-50-devices.md` | `9338e64535164a14cc7935752b93cdec0d061697e0dbe1ddbe510f34b4591bf0` |
| `docs/prnas-storage-50/NEXT-TODO.md` | `b59384820aa61f2b185677ebf2c73740ddfb9dc97bef58ac4f6c51626dcb014d` |

git blob of harness：`29bc50d4c232961319ff5894250d7529e933789d`

## COVER01 解析（权威 JSON 在仓内，用户所述私有文件名不存在）

缺失：`/Users/fu-121/.local/state/p003-prnas-t5-20261117/LOAD-50x6000-COVER01.json`
存在：`docs/prnas-storage-50/t5/LOAD-50x6000-COVER01.json`（1,143,473 bytes）
启动：`/Users/fu-121/.local/state/p003-prnas-t5-20261117/CLOUD-START-50x6000-COVER01.json`

| 字段 | 值 |
|---|---|
| stage | `T5_INCREMENTAL_LOAD_NOT_FULL_ACCEPTANCE` |
| covering_index | true |
| devices×events | 50×6000 |
| events_accepted | 300000 |
| duplicated | 0 |
| batches | 1500 |
| duration_ms | 544148 |
| ACK p95 / p99 | 395.001747 / 1088.166792 ms |
| attempts / 200 / 503 | 4270 / 1500 / 2770 |
| dirty_days（结束后） | 0 |
| ark correct | 50/50 |
| maintenance | 1897 / 44301 / 42854 ms，code 0,0,0 |
| backup_exit | 0 |
| checkpoint failures/timeouts | 0 / 0 |
| last reclaimed | false |
| systemd MemoryPeak | `[not set]` |
| health 样本 | 587（跨度 587119 ms，中位间隔 1000 ms） |
| rss first/min/max/last | 148176896 / 148176896 / 305598464 / 276574208 |
| rss >256 MiB 点数 | 548 / 587 |
| wal first/max/last | 346112 / 271462712 / 204343792 |
| wal ≥256 MiB 点数 | 122（`wal_pressure` 122，`/ready` 503 共 123） |
| disk_free first/last/drop | 11382738944 / 10196791296 / 1185947648 |
| rollup partial 点数 | 244（remaining_dirty=1） |

24h 外推（1 Hz 全文 health 留内存+RESULT）：紧凑约 103 MiB，pretty 约 128 MiB。

## 首轮对照（无 cover，整体 FAIL）

`LOAD-50x6000-01.json`：300000 accepted，ACK p95/p99=394.72/1278.98，503=2634，dirty=1，MemoryPeak=693379072，stage 同为增量非满验收。

## 容量纸面（成熟 + cover）

| 输入 | 值 | 来源 |
|---|---|---|
| 成熟库字节 | 44871368704（44.87 GB） | T2 MATURE / T4 MATURE-CALIBRATION |
| facts 行 | 54000000 | 同上 |
| cover 增量 | 178515968 B / 600000 facts | COVERING-POLL-02 / STATUS |
| cover / 成熟副本 | 16066437120 B ≈ 14.96 GiB | 178515968/600000×54000000 |
| 五副本 cover 额外 | ≈ 74.8 GiB | ×5 |
| 180d 五副本数据预算 | 324086400000 B ≈ 301.9 GiB | t4/evidence/CAPACITY-MODEL-FINAL.json |
| 现役根盘 | vda 42949672960 B | t5/READONLY-STORAGE-INVENTORY.json |
| 库存盘空闲快照 | 约 12.3 GiB | 同文件 / POSTLOAD-PRODUCTION-GUARD |

## 明确未跑 / 未形成证据

A01–A05，A06 600k，A08 成熟净清理与锁 p99，A09 Ark 查询，A10 语音 50 轮，A11 72h+1h NAS，A12 超预算，A13 规模恢复，A14 24h，A15 回归回滚，ACCEPTANCE.md，storage-capacity-profile.ts，成熟 cover 容量重算入库，新隔离盘。


## 收尾 HEAD

落盘瞬间 HEAD 已变为他人文档提交 `9efbacac62ac98629668644e13069527a5547a30`（3 个 docs，无源码）。开工仍是 `7e695c80`。本审计未 commit。收尾 porcelain 空。
