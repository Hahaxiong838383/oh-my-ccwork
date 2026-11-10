# Grok Listening Review

审查对象是倾听池已提交的 `fd3ad604c64079b607fbfc285c5d7c9baf2002df`，工作树干净。父提交就是线上基线 `ac18707965623b85540408fc1d989eacb04ce798`。主池同一修复固定在 `148107232d1792c2c39719113d49031c67170d13`。

结论：**没有阻断项**。这次提交只把有界路由修复接到现役倾听池，四份源码里的倾听与 r20–r27 行为还在，取消清 `active` 和提交 turn 绑定与主池 actor 一致。

## 范围

相对基线只改了这 5 个路径：

- `rust-worker/src/ordered_pcm.rs`（+38/−若干，净增约 31 行）
- `rust-worker/src/search_policy.rs`
- `rust-worker/src/search_routing.rs`
- `rust-worker/src/search_tasks.rs`
- 新增 `rust-worker/tests/fixtures/weather-place-contract.json`（3230 条 `input`/`stations`）

`POOL_SOURCE_HINTS.json` 里线上 `build_sha` 已是基线 `ac187079…`，binary `1fd53248…`。本审查没有改源码、设备、生产或凭据，没有装依赖，也没有重跑测试。天气执行后台（供应商回退、预览写库）不在这 4 个文件里，没有复审。

| 文件 | sha256 |
| --- | --- |
| `ordered_pcm.rs` | `abe02f2e979401785156fd2f63b2e7afdea66c15b9b7ef93eb345f11446bc541` |
| `search_policy.rs` | `b799e076e53461ab9a69b2a980a2bb1d9fd01e5eb4c9496e6d19cb48b2436165` |
| `search_routing.rs` | `71ad2d36de7b6cce2ed48904b361c6865bc1e35f6769d8147eb57b7e7bc64313` |
| `search_tasks.rs` | `16e4ee7efde1b1aeb4d48a8395533ae6e8a25abfe1200e69003de4dfbc02aa9d` |
| `weather-place-contract.json` | `f20605883e6f44ac7926eab79a30314e8c4e61839f1da7f9dbe53480982d26b2` |

`weather-places.json` 不在本次提交里，sha256 仍是 `40f4cc66ff051ab205e9299e7b13bf458b62b28b4ce9e6e8e3a7a141b7ded69b`。

## 重点结论

`ordered_pcm.rs` 与主池 `14810723` 字节相同。新增唤醒变体只在 `limits.first_turn_rtc` 为真时生效：`可小可`、`呃小可`、`额小可`。普通轮仍走 `textproc::is_wake_only`。测试要求 `is_wake_only("可小可")` 为假，并且分段 final「可小可」加「我口渴了」在拼接后提交。`session()` 的 `first_turn_rtc` 为假，`session_v1()` 才把它打开。

r20–r27 的现有测试函数还在 `search_policy.rs` 与 `search_routing.rs` 里，本次 diff 没有删它们。r23 仍要求「成都今天下不下雨，放学适合打球吗」取成都、「冷水江今天天气」保持冷水江、「北京海淀明天会下雨吗」取北京海淀。r26 仍要求显式城市走 `place_weather`，下周这种未适配日期不落到本地定位。r27 页面朗读、r21 词义解释、r20 续播碎片都留在原测试里。

有限天气附属句只剥完整后缀，例如「告诉我要不要带伞」「告诉我会不会下雨」「告诉我」。原句仍留在 `d.query`。地点串里还剩「告诉我 / 天气 / 今天 / 明天 / 后天」且整串不是已知地名时，`expanded_weather` 返回空，不取第一座城。「深圳今天的天气告诉我北京要不要带伞」因此没有 `place_weather`。「北京和上海明天天气告诉我」走 `clarify_city`，`query` 为空；下一句「深圳」只接上保存的「明天天气」，结果里不含「北京」。原先「北京和上海天气」整串送目录的断言改成了这条澄清。按同样的别名规则扫过目录生成名，83636 个名字里没有任何一个能被「以及 / 还有 / 和 / 与 / 、」切成两个已知地名。呼和浩特、冷水江、会同县、和县仍是已知地名。

「不要查了」仍在精确取消表里，也在从句前缀表的第一位，先于「不查了」。因此「不要查了取消搜索」命中原有肯定停止，不会被新的「查了…」截走。否定和转述仍不是取消：「不要取消搜索」「不查了是什么意思」「不查了，取消搜索是什么意思」。主池 policy 的取消表没有「不要查了」，倾听这份是有意保留。会话里的「查了取消搜索」只在已有查询或结果时成立，无任务时 `interpret` 返回空。

取消会先把 `cancelled_locally` 置真、`busy` 置假、清掉 `speech` / `remainder` / `dialogue`，并把 `active` 置空，然后再 `try_send`。队列满时旧 epoch 事件不能再把 `busy` 放开，所以本地已经放开。之后的 `Resume` 看到 `cancelled_locally` 就拒绝把旧任务叫回来。新的 `submit` 成功才把该标志清掉。

`run_with_deadline` 与主池 `14810723` 逐字节相同。提交时先把 `submitted_turn` 设成本次 turn，把 replace 目标写进 POST 之后立刻清掉 `current`。取消无论远端是否确认，都清掉 `current`、`current_delivery`、`submitted_turn`，并把 `polling` 置假，然后发 `Finished`。轮询时已有 `current` 就按 `task.id` 过滤；POST 回执丢失、`current` 为空时，只接受 `task.turn` 等于 `submitted_turn` 的条目。取消之后 `submitted_turn` 为空，旧 task 不能借新 epoch 复活。

## 边界

归档日志 `worker-listening-all-reviewed.log` 已打印库测试 `674 passed; 0 failed; 2 ignored`，以及 `listening_core` 30、`listening_runtime` 13、`listening_voice` 10，文件头 `rc` 为 0，mtime 为 2026-11-10 13:40:53。这比首次整合的 673 多 1，与新增的 ledger 身份测试数量一致。文件头 `source_sha` 只有 `playout`、`pipeline`、`business_runtime`、`job`，不含这 4 个文件。本审查没有重跑，也不把该日志当成设备或生产通过。

契约 fixture 只核对了顶层形状：3230 条，3228 条有站点，2 条为空。新测试用它做「有站点才算已知地名」的成员检查。站点解析仍在 Brain。本审查没有逐条重验站点号，也没有复跑天气后台。

带 `current_grant` 的取消早退会清 `current` 和 `polling`，并发送 `Finished`，这一段不清 `submitted_turn`。这与主池 `14810723` 相同。下一次 `Submit` 会先覆盖 `submitted_turn` 再进入可能丢失回执的轮询，所以它不重新打开已测的旧 task 复活路径。多个 id 的取消文案同样会在本地停掉轮询，这也与主池相同。
