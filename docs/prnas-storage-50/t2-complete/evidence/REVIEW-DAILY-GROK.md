# 2183eb0c 日界增量复验

结论：**PASS_CODE_2183_B5_PENDING**

只覆盖 `2183eb0cb843812582b5ca8adeac11ac1dd1d903` 相对已通过的 `4354512d1258107cb539767d80edc75ba1e03124`。执行模型 Grok 4.7。这不是 T2 完成，也不是生产发布。B5 仍待主 13 交证据后另核；本次未读进度、未等 NAS 库。未改源码、未部署、未发外部消息。工作树干净，HEAD 即该 SHA。

## 差异与复用

全库只改 3 个路径。`apps/server` 544 个文件里 blob 变化 2 个：`scripts/storage-backup-job.py`、`scripts/storage-backup-job.test.py`。`IMPLEMENTATION.md` 只改日界表述。其余运行文件与 435 字节相同，沿用会话 340 的 `PASS_CODE_WITH_B5_PENDING`，未重审全文、未重跑全套件。与 340 记录一致且本次抽出仍相同的包括 `analytics-maintenance.mjs` `9c0fa35fb5b788bb257636251547b2d11fe04f931fb26d8a5fa06c64018f68e3`、`storage-lock.py` `d185c9bf108a9fb0476d275c797d73e61606f6c2b8db5a7a69ce982083f54fb2`、`storage-nas-verify.mjs` `c2028fecac834adbae196fcb3460b25bf1069a0160ec29f693d13c6ebba11e09`、`storage-mature-fixture.py` `65b337a1f155bf7c9551e5f7a3fd85bb6bc3fbb43ffe90300d29317fff668d8e`。新 job SHA-256 为 `5e61efcb141ca6831b4ee64d8e88b1374d6b338c9c0548db1ced7c2b596d20db`；435 的 job 仍是 `377cca0129f2bce589c432d57ba7b1afd2853e21e75b81f519a18b80cfb456e6`。

业务改动一行：已 ACK 的最新份若与 `now` 同属 CST 日 `(ms+8h)//86400000`，返回 `not_due`。未 ACK 仍在该判断之前返回 `waiting_for_nas`。

`git archive 2183eb0cb843812582b5ca8adeac11ac1dd1d903 2-Projects/P003GameDemo20260513/apps/server` 退出码 0，12,759,040 字节，解压到 `/tmp/p003-grok-daily-2183eb0c`。抽出的 job/test 与 git blob `0fca30d0` / `2a06a3f8` 一致。`REGRESSION-2183eb0c.json` 所记两份日志 SHA-256 与磁盘文件一致（`51ad42a6…e2f45`、`66c570c3…afaa6`）；那是主 13 的记录，本次没有重跑。

## 本次执行

Python `/opt/anaconda3/bin/python3` 3.12.2，SQLite 3.46.0。目录是归档树的 `apps/server`。

`/opt/anaconda3/bin/python3 scripts/storage-backup-job.test.py`：2026-11-16T06:12:30Z，退出码 0，Ran 7 tests in 0.496s，OK。

独立探针 `/tmp/p003-daily-cst-probe.py`（不走 unittest）对新脚本退出码 0（06:12:32Z）。起点 `1799949600500`，CST 日 20833 的 02:00:00.500，除第三项外均已 ACK：

| 用例 | 时刻 | 218 结果 |
|---|---|---|
| 同日不重复 | +20h 仍日 20833 22:00:00.500；当日末 23:59:59.999（间隔 79,199,499ms） | 两次 `not_due`，包数 1 |
| 下一自然日提前 400ms | `1800036000100`，日 20834 02:00:00.100，间隔 86,399,600ms | `published`，包数 2，`created_at_ms` 即该时刻 |
| 前一份未 ACK | 同一提前 400ms 的次日 | `waiting_for_nas`，包数 1，`oldest_pending_ms=1799949600500` |

负向对照：同一新测试文件配 435 的 `storage-backup-job.py`（blob `ee893fce`，SHA-256 与上表旧值相同）。2026-11-16T06:12:31Z，退出码 1，7 项里仅 `test_next_cst_day_is_due_even_when_timer_fires_fractionally_earlier` 失败：`'not_due' != 'published'`。同一探针对旧脚本按旧预期退出码 0：同日 `not_due`，提前 400ms 为 `not_due` 且包数 1，未 ACK 仍 `waiting_for_nas`。

无新的代码阻断。B5 与生产放行不在本结论内。
