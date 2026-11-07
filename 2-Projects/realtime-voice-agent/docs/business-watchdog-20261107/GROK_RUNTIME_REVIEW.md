# 87c417a 业务 deadline 接线复审

审查对象只限提交 `87c417a3764b82c7ff62f9596136c179217a542f`（`git show` / `git cat-file`）。工作区里未提交的 `ops/search-canary/reconcile_rooms.py` 与其测试没有读入候选。未改业务源码，未部署，未删房，未装依赖，未重跑 Linux `523/523`。

`docs/business-watchdog-20261107/RUNTIME_WIRING.md` 与 `RUNTIME_WIRING_EVIDENCE.json` 把 523/0 写成既有离线隔离测试，并写明不是发布、没有真实 RTC。本轮不把该计数当成上线证据。

已共同收紧的边界不再重开：心跳不等于业务进展；10 秒打点不能证明没有 5 秒停顿；整数幅度 0 不等于样本全 0；最初输入和 12 票缺口未定因。已知未完成项（主池持久清理重试、倾听池未移植）不作为新发现。

行号均指该提交中的文件。私有对照副本在 `grok-runtime-87c/`。文中的控制流结果来自对该提交函数的逐行转写，不是 `cargo test`。

## 总判

enforce 且签了 5–300 秒策略时，普通 RTC 的启动保护会被「有长度的静音/低门限帧」拆掉，房间在 `idle_ms`（下限 5 秒）关闭，而不是文档写的 60 秒无有效输入。ordered PCM 整段不调用 `progress`，绝对截止只覆盖一次 `begin_to_end`（默认 7 秒），到点且此前没有 VAD/PCM 进展就会关房。搜索轮询和回复 40 秒持有不会因为重复 tick 续命。房间名在 ListRooms 与 DeleteRoom 之间被换成新 SID 时，按名字删除会删掉新房，读回空列表后仍报 Gone。

## 1. 普通 RTC / VAD / ordered / 本地承接 / 输出门 / 回复 40 秒 / 搜索

### 阻断：有长度的非进展帧解除启动保护

文档写「空音频帧不能解除启动保护」。模型测试喂的是 `sample_count == 0`：

- `rust-worker/src/business_runtime.rs:42-45`：`sample_count > 0` 才 `first_frame`。
- `business_runtime.rs:130-134`：60 秒内每 50ms 喂 `0`，期望 `Close(StartupNoInput)`。
- `business_watchdog.rs:33-38`：`first_frame` 在启动窗内把 `ready` 置真，不改 `last_progress`。
- `business_watchdog.rs:59-69`：`ready` 之后走空闲判断；`now - last_progress >= idle_ms` 即 `IdleNoProgress`。`new()` 把 `last_progress` 放在 0（`business_runtime.rs:35`）。

热路径传的是缓冲区长度，不是非零样本数：

- `pipeline.rs:1180-1181`：每个 RTC 帧 `input_frame(now, samples.len())`，位于 ordered 丢弃 `continue`（`1239-1259`）之前。
- 同一次循环里 `AudioStats`（`1180`）统计了 `nonzero`，决策不用它。10 秒日志（`1374-1383`）只打印后清零。

可复现前提：`P003_BUSINESS_WATCHDOG_MODE=enforce`，允许列表命中，metadata `timeout_ms=5000`、`revision=cfg-1`。assignment 后从 1.000 秒起每 20ms 一帧 320 个 i16 零（或任意长度、但 Silero `p < 0.6` 的帧）。没有搜索、没有 agent turn。

转写结果：长度 320 的帧在 5.000 秒得到 `Close(IdleNoProgress)`，`ready=true`，`last_progress=0`。同一时钟上长度 0（现有单测形状）在 5 秒仍是 Keep，到 60 秒才是 `StartupNoInput`。因此现有单测锁不住这条热路径。

这不是「心跳当进展」，也不是「10 秒桶漏掉 5 秒停顿」。这是 60 秒启动窗被普通开麦帧换成从 assignment 起算的空闲窗。人如果在接通后 6 秒才开口，enforce+5 秒策略会在开口前关房。

### 阻断：ordered 语音与未过 VAD 门的声音都不续命，截止不滑动

进展只有三处生产调用：

- `pipeline.rs:1284-1285`：仅当 `p >= gate.activation_threshold`。默认阈值 0.6（`894-898`）。这发生在 ordered 首句 `continue` 之后，首句期间执行不到。
- `pipeline.rs:1391-1394`：同一 turn 的 `captured_samples` 变大。
- `pipeline.rs:1295-1298`：ordered 包只 `input_frame(now, submitted)`。`submitted` 是送进 ASR 的样本数（`1498-1525`），仍然只武装 `ready`。Idle→Receiving 时把 `business_ordered_until` 设为 `now + begin_to_end` 一次。默认 `begin_to_end_timeout_ms=7000`（`ordered_pcm.rs:271,299,524`）。

`activity_until` 在截止 Instant 不变时直接返回，不增加 generation（`business_runtime.rs:50-63`）。转写：Receiving 期间每 40ms 再喂 640 样本、每次传入同一个 8 秒截止，generation 保持 1；7.999 秒 Keep，8.000 秒 `Close(IdleNoProgress)`。音频还在到，也不会续。

因此：

- 搜索式「每拍 `now+预算`」在这条 Input/Reply 接线上没有发生。
- ordered 唱歌、长口述、唤醒词都不会因为「有声音」续命。
- 唤醒词 `no_task` 把相位打成 Terminal（`ordered_pcm.rs:1107-1122`），不再是 Receiving|Ended（`pipeline.rs:1403-1404`），Input 持有被清掉，且不进 LLM。若 `ready` 已由开麦帧置位且 `last_progress` 仍为 0，下一次已超过 `idle_ms` 的 evaluate 关房。端侧本地 greet 之后的 RTC 承接没有新的启动窗。
- 仍在 Receiving 且超过 7 秒时，协议自己也会 `fail(Timeout)`（`ordered_pcm.rs:1132-1136`）。业务截止同时关的是整间 job，不是只废一代再切 RTC。

本地承接默认 `ORDERED_LOCAL_RECEIPT_MAX_MS=3000`（`pipeline.rs:188` 一带，使用点 `3594-3601`）。正文门扣住 PCM 时 `captured_samples` 可以不涨，但回复持有是 `turn.started + 30s + 10s`。默认 3 秒落在这 40 秒里面，不另构成一条误杀。若把该环境值调到大于 40 秒，且 ordered 丢弃了 VAD，则会在 `turn.started+40s` 关掉仍被门扣住的正文。这是非默认前提。

输出门 5 秒 fail-closed（`pipeline.rs:1159-1163`）没有接进 `progress`。未订阅且无 VAD 时，上面的 5 秒空闲会自己关房。

### 回复 40 秒：不无限续；PCM 停够 idle 会在任务仍活着时关房

`pipeline.rs:1396-1399`：turn 任务未结束时，截止固定为 `t.started + llm::REQUEST_TIMEOUT + tts_xfyun::CONNECT_TIMEOUT`。两者分别是 30 秒和 10 秒（`llm.rs:580`，`tts_xfyun.rs:63`）。同一 Instant 重复传入不会增加 generation。转写 generation 为 1。

`business_watchdog.rs:66` 的持有条件是 `active && now < until`。过了 `until` 之后，任务没完也只是同一条过期截止。此后只剩 `captured_samples` 变化（`pipeline.rs:1391-1394`）。

可复现前提：enforce，`idle_ms=5000`，`last_progress` 在 T，turn 从 T 开始且任务到 T+45 秒仍未结束，T+40 秒到 T+45 秒 `captured_samples` 不变，没有 Search/Command/Input 持有。evaluate(T+40s) 起为 `Close(IdleNoProgress)`。

连续出 PCM 时每次样本数变化都会 `progress`，长播放本身不会被这 40 秒砍掉。误杀前提是 40 秒之后出现长于 `idle_ms` 的无新 PCM 间隙，而合成任务还在。真实讯飞句间是否超过已签空闲，本轮没有实机，标未验；接线在该前提下会关。

### 搜索：绝对截止不因轮询续命

`search_tasks.rs:796` 每圈用当前 `poll_until` 发布。Submit 先发布 4.5 秒（`828`），HTTP 结束后把 `poll_until` 设为当时的 `now+80s` 一次（`860`）。1 秒 tick（`932-933`）到期只停轮询，不改 `poll_until`。`business_deadline`（`280-286`）在 epoch 不符、actor 已结束、或时刻不在未来时丢掉它；remainder 不在链上。同文件测试约 `1601` 行断言成功轮询不改变已发布的 80 秒截止。

因此「搜索活动每拍无限续」在 87c 上不成立。80 秒是上限，不是滑动窗。busy、auto_pending、300 秒 `dialogue_context`（`635-636`）不进入 `business_deadline`。

队列里的提示句 `expires = now+10s`（`463-470`）和 receipt `now+2s`（`456-457`）会进入 `max()`。轮询截止更长时被 80 秒盖住。轮询结束后，一条还没播的 10 秒提示可以单独再持有到它自己的 `expires`。这是一次有界持有，不是无限续。

### 过门 VAD 会无上限续命，这与已接受合同一致，不单列阻断

`pipeline.rs:1284-1285` 每个 32ms 窗只要 `p >= 0.6` 就 `progress(now)`，没有说话时长上限。唱歌或噪声只要每个 `idle_ms` 内至少有一帧过 0.6，房间不关。不过门则回到上面的空闲关闭。本轮没有语料测量真实歌唱的 Silero 分数，所以「唱歌一定被误杀」或「唱歌一定被保住」都不写成已证实。代码只证明：过门则无上限 Keep，不过门则不续。

## 2. startup 共享 60 秒与 Owned prebuild

`startup_participant::STARTUP_BUDGET_MS` 是 60000（`startup_participant.rs:4`）。`Runtime::startup_deadline` 只在 enforce 且已有合法 `idle_ms` 时返回 `origin+60s`（`business_runtime.rs:66-68`）。observe / 非法策略返回 `None`（测试 `156-163`），`within_startup(None)` 原样等待（`73-86`）。这和「观察模式不用新启动门关房」一致。

connect 与 publish 使用同一个 `startup_deadline`（`job.rs:150-151` 与 `176`），没有第二段再加 60 秒。过期后先检查再 poll，完成后再次检查（`business_runtime.rs:79-82`）。单测 `97-109` 覆盖「立即就绪的过期 future 不被 poll」和「第二段不能重启预算」。

prebuild 在 connect 之前放进 `OwnedTask`（`job.rs:147`）。`spawn_after_prebuild`（`557-572`）只负责把等待挪进 pipeline 任务，测试 `784-797` 断言卡住的 prebuild 不会堵住 job 循环，并且 abort pipeline 会取消该任务。替换参与者时 `drop` 旧任务再起新的（`361-362`，`476`）。已建立 pipeline 后 `StartupParticipant::connected` 因 `started` 不再替换（`startup_participant.rs:28`，`job.rs:428` 在用户轨上置 `started`）。

这条共享预算没有被第二段重启。它盖不住第 1 节：一旦 `samples.len()>0`，`ready` 为真，evaluate 不再走 `StartupNoInput`。60 秒只保护「一个样本缓冲都没有」的阶段。connect/publish 本身在事件循环之前 `await`（`151-186`）；enforce 下由 `within_startup` 封顶，observe/off 下没有这道新超时。后者是文档里的观察语义，不是本轮新洞。

5 秒主循环惊闸仍要求 `beat > 0`（`job.rs:271-283`）。prebuild 尚未进入 pipeline 循环时 beat 为 0，这道惊闸不响。enforce 且尚未 `ready` 时，改由 60 秒 `StartupNoInput` 打断循环后再 abort。该保护在 pipeline 开始收有长度帧之后才会被拆掉，不发生在 prebuild 卡住期间。

## 3. room_verify 的 ListRooms / DeleteRoom

实现是前台一次删除加读回，不是持久重试。`job.rs:537-547`：只要 `business.is_some()`（observe 或 enforce，且设备在允许列表里）就走 `delete_exact`；否则仍走原来的 `delete_room`。`Gone` 和 `Superseded` 都记成 verified。

对照结果：

| 合同 | 87c 行为 | 结论 |
|---|---|---|
| 2xx 但原 SID 仍在 | Delete 的 HTTP 状态被丢掉（`room_verify.rs:29-30`）。读回仍是原 SID 则三轮后 `Pending`（`31-40`）。测试 `91-94`：200 且读回 `RM_original` → Pending，DeleteRoom 只发一次。503 且 SID 仍在也是 Pending（`107-109`） | 这条成立，不是误报成功 |
| 空数组 `{"rooms":[]}` | `read_sid` 52 行 `Ok(None)`。删前见到则 `Gone` 且不发 Delete（`26`，测试 `101-104`）。删后见到则 `Gone`（`96-98`） | 对这个 JSON 形状成立 |
| 缺 `rooms` 键，即 `{}` | `51` 行 `as_array()` 失败 → `Err` → 立刻 `Unavailable`，不把三轮读完（`35`）。测试把 `"invalid"` 编成 `{}`（`80`）并期望 Unavailable（`108`） | 缺键不等于空列表。不会因此报 Gone |
| 删前名单已是另一个 RM_ | `Superseded`，不发 Delete（`26`，测试 `101-104`） | 非竞态成立 |
| 名单与删除之间的 SID 复用 | 未覆盖 | 阻断，见下 |

阻断前提：`delete_exact` 第一次 ListRooms 看到 `name=房间名, sid=RM_original`。在 `DeleteRoom` 发出之前，该名字已被新会话占用为 `RM_new`。`DeleteRoom` 的 body 只有名字（`29-30` 与 `job.rs:674`），没有 SID。删除打到新房。随后 ListRooms 为空，`33` 行返回 `Gone`。`job.rs:540` 把 `Gone` 记成 verified。

现有 localhost 服务器用一个 `deleted` 布尔切换读回（`room_verify.rs:69-81`），不能在第一次 ListRooms 与 DeleteRoom 之间把 SID 从 `RM_original` 换成 `RM_new`。所以隔离测试里没有这条竞态。

真实 LiveKit 对「房间已不存在」是省略 `rooms` 还是返回 `{"rooms":[]}`，本轮没有打生产 SFU，标未验。接线文档第 37 行也写了上线前要核这个形状。若生产省略空 repeated 字段，成功删除的读回会落到 `{}` → `Unavailable`，前台永远得不到 `Gone`。这不会把失败报成成功；它使成功也无法被确认。不把「主池还没有独立持久重试」再报一次。

`ListParticipants` 没有被调用。`Gone` 只表示名单里没有这个名字。这和先前「两名参与者消失」的发布回读不是同一件事；本文件的声明范围就是 ListRooms。

## 4. 11 月 6 日生命周期与 TTS

相对回滚标签 `rollback/p003-business-watchdog-pre-20261107` = `c19e0964bca95d96e9816813daf76993383e399f`：

- `tts.rs` 与 `voice_connect.rs` blob 与该标签相同（`tts.rs` 均为 `37b962654355801ec21f5fa7b844c43865d8b838`）。`synthesize_connected`、10 秒共享 `recover_connection`（`tts.rs:212-216,253-282`）还在。
- `tts_xfyun.rs` 相对该标签只把 `CONNECT_TIMEOUT` 从私有常量改成 `pub(crate)`，时长仍是 10 秒。`RECV_TIMEOUT` 30 秒、`send_or_abort`、连接计时都在。
- `startup_participant.rs` 相对该标签只把字面量 `60_000` 提成 `STARTUP_BUDGET_MS`。替换 10 秒、离开 3 秒、总预算不被替换风暴延长、pipeline 已启动则关闭，这些分支还在。
- `f0f113bf` 与 `7fa56687` 是 87c 的祖先。`job.rs:896` 与 `917` 的生命周期测试还在。`owned_task.rs` 相对该标签无差异。

源码层面，11 月 6 日这两处修复没有被本提交删掉。本轮没有重跑它们的测试。新的 enforce `Decision::Close` 仍会 `break` job 循环（`job.rs:261`），所以第 1 节的误杀可以在 TTS 恢复代码还在的情况下把整间房收掉。那是新截止盖住了旧路径，不是旧路径被回滚。

## 未验

- 没有重跑 `cargo test --offline --locked`，没有复核日志 SHA `375406ba…`。523/0 仍只引用作者的 Linux 记录。
- 没有真实 RTC、真实歌唱、真实长 TTS 间隙、真实 SFU ListRooms 空响应。
- `within_startup` 在期限当毫秒返回成功时，完成后的 `Instant::now() >= at` 可能再判失败（`business_runtime.rs:82`）。没有为这个边界做计时实验。
- 本机转写只覆盖第 1 节的状态机算术，没有把 pipeline 的 VAD/RTC 跑起来。

## 不作为新发现

主池持久关闭重试仍然没有；倾听池 `Activity::Listening` 没有接线调用；候选 reconciler 的窗口误删问题作者已写在 `RUNTIME_WIRING.md` 发布前清单第 1、3 条。这些保持为已知缺口。
