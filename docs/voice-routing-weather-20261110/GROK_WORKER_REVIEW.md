# Worker 只读复审

结论：无阻断。

评审对象是本工作树 `git rev-parse HEAD`：

`148107232d1792c2c39719113d49031c67170d13`

提交说明：`fix(p003): bind search polling recovery to the current request identity`。父提交 `4d7835d001fe0b5f62c73a8474891244f636856d`。基线 `f0380202eb93303bc69563d37c08bab6f3f9d0fa`，`git merge-base` 等于基线。分支 `codex/p003-voice-input-routing-fix-20261110`。写入本文件时 `git status --porcelain` 为空。

评审人没有运行 cargo，没有修改 Worker 源码，没有做生产或设备操作。Linux 数字只引用私有目录里已有日志，并用源码 SHA-256 绑定到字节。

## 身份

| 项 | 值 |
| --- | --- |
| HEAD | `148107232d1792c2c39719113d49031c67170d13` |
| 父提交 | `4d7835d001fe0b5f62c73a8474891244f636856d` |
| 基线 / merge-base | `f0380202eb93303bc69563d37c08bab6f3f9d0fa` |
| `src/search_tasks.rs` | `c5922ecd8f788b064a6b4d7f92b580178c310931d14147051068c098962e3574` |
| `src/search_routing.rs` | `394113db4dc32a96f51c2afc2f5d101baec32fd81eb82e0d94f5eae3e1a46901` |
| `src/ordered_pcm.rs` | `abe02f2e979401785156fd2f63b2e7afdea66c15b9b7ef93eb345f11446bc541` |
| `src/search_policy.rs` | `ac05fdb1013d05f986d7d7119ffa6486f6ed536880731278c159051efcf66ee6` |

`source-all-reviewed.json` 与 `source-reviewed-release.json` 里这四个文件的哈希与上表一致。`CANDIDATE.json` 仍写着父提交 `4d7835d001fe0b5f62c73a8474891244f636856d`，二进制 `6cdd761fd3cfb74fcd43166132f6187904c405553253e6ef43fc7b31ac33163e`，76328584 字节。那张卡片对不上本 HEAD。`worker-reviewed-release.log` 记录的 release 二进制是 `8a9534897303b8f12406df47a51bf70dba8d26ef44efd56e27db4601f5ea50a9`，76329944 字节，且其 `source-reviewed-release.json` 含本 HEAD 的 `search_tasks.rs` 哈希。评审人没有重算该二进制。

相对基线，Worker 行为改动在 `ordered_pcm.rs`、`search_policy.rs`、`search_routing.rs`、`search_tasks.rs`，另加 `tests/fixtures/weather-place-contract.json`。本轮最后一提交只改 `search_tasks.rs`。

## 规格

`GROK_TEST_MATRIX.md` 已通读。它是设计矩阵，签名为 grok，基线为 `f0380202`，状态是未执行。它不是本轮验收oracle。旧 C08「明天是核心、后天是附属，仍选明天」不采纳。多日期必须保守，不能落固定天气。实现是 `search_routing.rs:84`：`今天` / `明天` / `后天` 出现次数大于 1 时 `weather_parameters` 返回 `None`。

用户点名的 `docs/superpowers/plans/2026-11-10-p003-voice-routing-weather-execution.md` 不在本树。本轮读的计划是 `docs/voice-routing-weather-20261110/EXECUTION_PLAN.md`。Brain 与 UI 不在本轮。

## Linux 证据绑定

评审人没有执行这些测试。

| 日志 | 结果 | `search_tasks.rs` | 绑定 |
| --- | --- | --- | --- |
| `worker-baseline.log` | 583 passed，0 failed，1 ignored | `fb3de60ff557336e82aee96d2db76aa48c1740e27cf9100890d9483d1a905827` | 基线 |
| `worker-full.log` | 594 passed，0 failed，1 ignored | `0c024240fd7fb28889e6dad275e0cf7dc1a2898922f31b25a403947fc0c1eae2` | 提交 `40399f5d`，早于本 HEAD |
| `worker-full-final.log` | 595 passed，0 failed，1 ignored | `3dce74c60bb0866562e84645c88c26454b4217d5b6c7ab98da740e83d8293713` | 父提交 `4d7835d0`，尚无本轮身份过滤 |
| `worker-identity-red.log` | rc 101，该测试 failed | `49c57da58b2cc013884a56a1d81435608a5806fd9703845aafed9bc5dbb869fe` | 中间字节，不在本分支提交里。断言 `left: old`，`right: new` |
| `worker-identity-green.log` | 1 passed，596 filtered | `c5922ecd8f788b064a6b4d7f92b580178c310931d14147051068c098962e3574` | 与本 HEAD 相同 |
| `worker-all-reviewed.log` | 596 passed，0 failed，1 ignored，10.63s | 同上 | 与本 HEAD 四个文件哈希相同 |

596 = 583 + 13。被过滤的单测运行是 1 + 596 = 597，与全量 596 passed + 1 ignored 一致。新增用例在这 13 个里面。1 个 ignored 从基线就有；两份全量日志都没有打印它的名字。`listening-*` 日志的 `search_tasks.rs` 是 `7843ec0f…` / `c123f7fd…`，属于另一棵源码，不能当作本候选的验收。

红日志证明修复前下一轮 poll 会把账本里的 `old` 标成 epoch 3。绿日志和 596 跑在当前这组字节上。

## 已核对且成立

### 取消后的下一任务

`search_tasks.rs` 在 Submit 时记下本次 `turn`（855），把替换目标只放进 POST，随后清掉 actor 的 `current`（861-864）。有任务 id 的回执才把 `current` 设回该 id（886）。取消无论 HTTP 成功、503 或多 id，都执行 `current = None; current_delivery = None; submitted_turn = None; polling = false`（914），再发本 epoch 的 Ack 与 Finished（915-916）。

poll（975-985）只在两种情况下发 `Ready`：`current` 已有 id 时跳过其他 id；`current` 为空时，只接纳 `task.turn` 等于 `submitted_turn` 的条目，并记下该 id。旧任务的 turn 不同，不能继承新 epoch。

可执行用例已在树内：`routing_cancel_next_submit_cannot_relabel_old_ledger_result`（1164-1196）。桩让第一次 POST 返回 `old`，`/{id}/cancel` 返回 503，列表同时含 `old`（文案「不该复活的旧结果」）和 `new`。`lost_ack` 为 false 与 true 各一轮。期望 epoch 3 的 `Ready.id` 为 `new`。Linux 红日志在修复前失败，绿日志在本哈希上通过。

以下路径仍然成立，不另开问题：

- 旧 epoch 的 Ready / Ack 在 `poll` 524 行按 epoch 丢弃。`routing_cancel_releases_busy_and_rejects_late_result_and_ack`（1209）。
- `cancelled_locally` 仍为真时，显式 Resume 只提示重新查询，不发命令（394-396）。`routing_cancel_explicit_resume_does_not_revive_locally_cancelled_task`（1224）。
- 队列满时 Cancel 的 `try_send` 失败，本地仍把 busy 放开并提示没能确认取消（381-390）。`routing_cancel_full_command_queue_does_not_leave_a_permanent_busy_lock`（1245）。
- 取消先把 `active` 置空（380）。迟到的播放结束不能把旧稿写回 remainder，也不能清掉新任务的 busy。`routing_cancel_late_playback_finish_cannot_restore_remainder_or_clear_new_busy`（1233）。
- 503 的文案是「暂时没能确认取消，请稍后再试。」并仍发 Finished。`routing_cancel_http_failure_stops_polling_old_task_without_false_confirmation`（1253）。该测试在 Finished 后中止 actor，不覆盖下一 Submit。

队列满时 Cancel 没有进 actor，actor 仍可能用旧 epoch 发 Ready；会话按 epoch 丢弃。下一次成功 Submit 走上面的 turn/id 过滤。树内没有「塞满 16 条命令后再断言 epoch 3 不会 Ready `old`」的组合用例。逻辑与已通过的身份用例相同，记为验证边界。

### 天气

`weather_request_core`（104-117）只剥完整、有界的后缀，且剥完后核心仍须是天气话题。`告诉我要不要带伞` 在后缀表内（109）。`weather_place_words`（130-144）只在边缘剥词，余下部分一旦命中地名集合就停止。`深圳今天的天气告诉我要不要带伞` 因此得到 place `深圳`、day 0、forecast；查询文本保留原句。树内直接断言的是带「帮我查一下」的句子和带逗号的句子（287-288），以及 `深圳今天的天气告诉我`（290）。无前缀原句走同一后缀函数。`expanded_weather`（146-151）在地名未知且残留「告诉我 / 天气 / 帮我 / 要不要 / 需不需要 / 今天 / 明天 / 后天」时拒绝结构化天气。

`深圳今天的天气告诉我北京要不要带伞` 与 `深圳今天天气告诉我北京冷不冷` 不产生 `place_weather` / `weather` / `auto_weather`（327-329）。北京停留在从句里，不会被当成 place。

多日期在剥核心之前就看整句（84）。`深圳明天的天气告诉我后天要不要带伞`、`深圳今天明天的天气`、`深圳明天后天天气`、`现在深圳明天多少度` 都没有固定天气（309-311、327）。这是保守策略，没有实现被拒绝的 C08。`大后天` 在黑名单里，不会因包含「后天」而变成 day 2。

`北京和上海明天天气告诉我` 得到 `clarify_city`，pending 只有「明天天气」，后续「深圳」的查询不含北京（314-319）。`multiple_weather_places`（119-123）只在 `以及 / 还有 / 和 / 与 / 、` 上做一次 `split_once`，两侧都须是已知地名。

`routing_weather_catalog_contract_matches_authoritative_names`（274-281）用 `weather-place-contract.json`：已知当且仅当 stations 非空，且已知地名满足 `weather_place_words("{place}明天天气") == place`。该测试在 596 所绑定的 `search_routing.rs` 哈希内。Worker 不发气象站 id。`冷水江`、`会同县` 靠整名命中停止剥词（293-294）。Brain 仍是站点解析的权威。

### 首句

过滤发生在收流结束、把本代 `held_finals` 拼成完整文本之后（1106-1109），并且只在 `limits.first_turn_rtc` 时启用。`is_first_turn_wake_only`（1224-1227）先调用原有 `textproc::is_wake_only`，再精确匹配规范化后的 `可小可`、`呃小可`、`额小可`。规范化会去掉空白和 `，。！？!?.、~～…`。第二轮不复用这张表。`job.rs` 只在 metadata `oneshot_first_turn == "v1"` 时打开 `first_turn_rtc`。时长不参与这个判断。矩阵里的 0.5 秒 / 8000 样本不是这条路径的门槛。

### 取消说法

`search_policy.rs:83-91` 把「不查了 / 别查了 / 不用查了」以及可选分隔后的「取消搜索」判为 Cancel，不先剥掉否定或引语。替换判断在取消之前（先不查……了，改查）。`不要取消搜索`、`不查了是什么意思`、`他说取消搜索是什么意思`、无状态的 `查了取消搜索` 不是 Cancel。有进行中的查询时，会话态才把 `查了取消搜索` 当成 Cancel。

## 验证边界

无阻断。下面这些边界没有被本轮证据关闭，也不单列成新需求。

1. 下一成功 `submit` 会把 `cancelled_locally` 清掉（469）。此后若本地没有有效 remainder、`resume_v1` 打开，且当前不 busy，Resume 会发 `ResumeLatest`（426-429、839-848）。actor 认领 `/resume/latest` 返回的 resume，没有已取消 task id 黑名单。`resumed_speech`（739-746）要求 grant、UUID task_id、64 位 digest 和句数，这和任务列表里的 Ready 文本不是同一条路径。现有 Resume 测试只覆盖标志仍为真的时候。没有服务端证据表明任务取消 503 会让 `/resume/latest` 返回该任务，所以不记阻断。若要关闭这条边界，可执行用例是：POST 接受 `old`，`/{id}/cancel` 返回 503，下一 Submit 被 HTTP 拒绝因而没有 remainder，再发 Resume；断言不出现 `task_id == old` 的 `Claimed`。

2. `current_grant` 分支的取消（900-902）在 `continue` 前没有清 `submitted_turn`。该分支把 `polling` 设为 false。下一次 Submit 会覆盖 `submitted_turn`。当前循环里没有一条路径会在覆盖前用旧 turn 去 poll。

3. 多个 id 时文案是「现在有多个查询，请说明要取消哪一个。」（907），随即清掉 `current` 与 `submitted_turn`（914）。这句话之后本地已经没有可选择的 id。这是原有文案，本轮不把它扩成新需求。

4. 无前缀原句 `深圳今天的天气告诉我要不要带伞` 没有单独的 assert，覆盖它的是同一后缀表和带前缀 / 逗号的用例。`北京，上海` 中间的逗号不是 `multiple_weather_places` 的分隔符，两个城市都不会被选中。朝阳有多站时 Worker 保留短名，不替 Brain 选站。这些都不新开要求。

5. 本机没有 cargo。594 与 595 不覆盖本 HEAD 的 `search_tasks.rs`。596 的源码哈希与本 HEAD 四个文件一致，但是评审人没有重跑。没有 HTTP 联调、设备或声学验证。ignored 测试的名字不在日志里。

## 不在本轮

Brain、UI，以及 `listening-*` 那组不同哈希的 Worker 源码。
