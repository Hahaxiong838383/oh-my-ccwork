# P003 T3 pending 循环增量复验

结论：通过。只覆盖 `11ef01ecf0e05bebb2af77b6d8cfb26c813b195b` → `4ea6af5afb8fbd80133a7a48fbeea9565d135217` 的 cycle pending 循环。同一混合测试在前版导出脚本上失败，later 批保持 `published`；候选上 9 项全部通过，later 批为 `complete`，两条待发仍在。

## 固定提交

- 前版：`11ef01ecf0e05bebb2af77b6d8cfb26c813b195b`
- 候选：`4ea6af5afb8fbd80133a7a48fbeea9565d135217`
- `4ea6af5a^` 等于前版。
- 两提交之间只有两个文件：`storage-ark-export.py`、`storage-ark-export.test.py`。
- 导出脚本 blob：前版 `8481c77e7577fde1ec0f7c065e98d00458990d20`，候选 `35499f6d34345209ba965732426de398a4e6e60a`。
- 测试 blob：`3052700189ddc58640a0da608cb4bd26a3f17d10`。
- 夹具 blob：`35f65e578e8d68671cb4590fe68ae49106a85f8c`（`2-Projects/P003GameDemo20260513/docs/ark-brain-20261031/snapshot-v1.example.json`）。

候选脚本只改了 pending 循环：磁盘预留 `ValueError` 记下 `disk_paused` 后继续检查已取出的后续批次，循环结束后再抛出 `archive_export_disk_reserve`。这个抛出仍在原有 `try` 内，因此会先写 `last_error='export_failed'` 再向外抛。其他 `ValueError` 在循环内立即重新抛出。

## 副本与命令

候选用 `git archive 4ea6af5afb8fbd80133a7a48fbeea9565d135217` 解到 `Path.resolve()` 后的目录。`/tmp` 的符号链接已解开，实际根是 `/private/tmp/p003-mixed-4ea-pyyiy5dz`。前版对照是同一归档，只把 `storage-ark-export.py` 换回前版 blob；测试文件仍是候选 blob。对照根：`/private/tmp/p003-mixed-11ef-7ukmmn7r`。

`apps/server/node_modules` 链接到现有目录 `/Users/fu-121/.codex/worktrees/p003-brain-search-tools-20261021/2-Projects/P003GameDemo20260513/apps/server/node_modules`。夹具相对 `apps/server` 的 `../../docs/ark-brain-20261031/snapshot-v1.example.json` 解析后与归档内夹具是同一文件。

两次命令相同，工作目录都是对应副本的 `apps/server`：

```sh
TEST_NODE=/Users/fu-121/.local/node-v24/bin/node TMPDIR=<resolved-tmp> python3 scripts/storage-ark-export.test.py
```

`TEST_NODE` 为 v24.19.0。Python 为 3.12.2。测试进程的 `TMPDIR` 也是 `Path.resolve()` 后的 `/private/tmp` 目录。未装依赖，未改仓库源码，未访问生产。

## 结果

前版脚本加候选测试，退出码 1。9 项里 8 项通过，混合项失败。`assertRaisesRegex(..., 'archive_export_disk_reserve')` 已通过，下一行断言失败：later 批状态是 `[('published',)]`。

- 日志：`/Users/fu-121/.local/state/p003-prnas-t3-20261116/grok-mixed-11ef-red.log`
- SHA-256：`b7c81136bbdb1415a17d53f767c3b9e94fa024c9465271894db9137f2cca3945`
- 耗时：5.480s

候选原样副本，退出码 0。`Ran 9 tests` 且 `OK`。通过的混合项断言是：later 批为 `complete`，`ark_archive_outbox` 计数为 2，随后一次不加磁盘补丁的 `cycle()` 后 spool 列表长度为 2。

- 日志：`/Users/fu-121/.local/state/p003-prnas-t3-20261116/grok-mixed-4ea-green.log`
- SHA-256：`5876f986faee0f0536ce101daa6bad2cf0cbd629e81304b9d4a8dc0e7c6eec91`
- 耗时：5.308s

`disk-mixed-red.log` 与 `disk-mixed-final.log` 只作对照，上述结论来自这两次独立运行。

## max20

归档候选中 `MAX_BATCHES=20`（第 15 行）。pending 查询带 `LIMIT ?`，参数是 `MAX_BATCHES`（第 133 行）。新的 `for b in pending` 只遍历这次取出的列表，循环体内没有第二条查询。`disk_paused` 为真时在第 140 行抛错，位于第 141 行 `while count['published']+count['confirmed']<MAX_BATCHES` 之前，因此这次磁盘暂停不会再领取新批次。while 上限本身没有被这次改动放宽。
