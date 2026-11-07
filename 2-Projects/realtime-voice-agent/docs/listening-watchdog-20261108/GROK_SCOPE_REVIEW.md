# 倾听池业务空闲回收：设计边界审查

审查者：Grok 4.7。本次只读代码并写本报告。没有改分支、设备或生产，没有跑测试，没有宣称实现完成或生产通过。

审查快照时间：2026-11-08 05:15 CST 之后数分钟。审查开始时 W 工作区干净；审查过程中 W 出现未提交移植（见第 8 节）。那些脏文件是观察到的方向，不是已验收实现。行号以符号和已提交版本为准；脏文件行号会继续漂。

## 1. 可证与不可证

可证（本地 git 与源码）：

- W `/Users/fu-121/.codex/worktrees/p003-listening-transport-20261108` 的 HEAD 是 `22ab1c3180fdf2788a7d7089758dd9c808ae904e`（`22ab1c31 docs(p003): verify and release listening feedback fragments`）。审查开始时 `git status --porcelain` 为空。
- `50bac0b28c4f44e169ad574c08682fe509a72a46` 是该 HEAD 的祖先。`50bac0b..HEAD` 只有上述 docs 提交，`rust-worker` 无 diff。因此已提交的 Rust 与用户所说的已上线 `50bac0b` 相同。这不证明线上进程仍是这个提交。
- M `/Users/fu-121/.codex/worktrees/p003-voice-transport-fix-20261105` 的 HEAD 是 `781f3e794f3869368c42b817296f894a8a5b043c`。`b9114ac6b7274e0a67ccffc4dde4a5bd5d5a77fe` 是其祖先。`b9114ac6..HEAD` 只有 docs，`rust-worker` 无 diff。已提交 Rust 与用户所说的运行中 `b9114ac6` 相同。这不证明线上进程仍是这个提交。
- 下面所有“已提交”锚点都来自这两个 HEAD 的文件内容。

不可证：

- 生产或设备上实际跑的二进制、环境变量、签票内容、reconciler 的 `status` 文件。
- 脏工作区能否编译，以及其中测试是否通过。本报告不把测试源码的存在当成测试已绿。
- Brain 线上是否总是下发 `voice_idle`，以及 lease RPC 的 `ttl_ms` 是否总是 15000。代码只拒绝 `until - now > 15000`。
- DNS、反馈分段、ASR/TTS 修复本身。那些不在本次范围，也不应被这次移植回退。

## 2. 结论

主池的纯计时模型可以原样搬进倾听池。关房权威只能来自已签的 `voice_idle`，加上已经收到的绝对 `lease_until` / `session_deadline`。不要把主池 schema 2、`begin_business`、`room_verify` 和 `roomList` JWT 一起搬进来。

倾听保护只做三件事：

1. `Listening`、`FeedbackReserved`、`FeedbackActive`：hold 截止时刻是已经写入的 `min(lease_until, session_deadline)`。
2. `Entering`：再与进入当时写入的 5 秒 `entry_deadline` 取更早者。不要把 15 秒租约整段套到进入过程。
3. 已认证的 `Exit`：记一次命令自带的 `now`，当作一次普通进度。之后只走签票 idle。不要再给一段租约，也不要让重复的 `State`/重复 `Exit` 刷新这个时刻。

下面这些 hold 应删掉或延后，不要为了让新测试变绿而保留：

- 待进入的 `pending_deadline`（Brain lease 未回，本地 `now+3000`）。
- 语音提议的 `proposal.deadline`（同样是本地 `now+3000`）。
- 用 `max()` 把上述本地截止和租约合成一个更晚的时刻。
- `voice_transition == true` 本身。
- 反馈时长、摘要轮询、静音帧、VAD 未激活的 tick。

无候选 schema 1 记录时，不要因此引入 schema 2。活进程关闭继续走倾听池现有的 `delete_room(..., listening)`。崩溃后的残留留给已经匹配搜索窗口的 schema 1 reconciler。把 `voice_idle` 的 `cfg-*` 写成 schema 1 的 `generation` 会让现有 reconciler 删掉仍活着的房。

## 3. 已提交基线（移植前）

### 3.1 主池计时模型，原样可用

`M/.../business_watchdog.rs`

- 时间是 job `Instant` 起的单调毫秒。`Policy.idle_ms` 在 `new` 里被滤成 `5_000..=300_000`，否则后面变成 `UnknownPolicy`，只观察不关。
- `first_frame` 只在 `started` 后、`startup_ms` 之前的第一帧把房间标成 ready，并记下 `ready_at`。再次调用不续期。晚于 startup 的第一帧不能把房间救活。
- `progress` 只做 `last_progress = max(last, now)`。静音、保活、旧的 playing 标志不得调用它。
- `begin_activity(kind, generation, budget_ms, now)` 的截止是 `now + budget_ms`。同一 generation 不能延长。`activity_until` 把绝对毫秒当成 `budget_ms` 且传入 `now=0`，所以截止就是那个绝对毫秒。这是隐式约定。倾听侧不要直接调用 `begin_activity(Listening, _, 15_000, now)`，否则每个 tick 都是一次新的 `now+15s`。
- `evaluate`：未 ready 且未过 startup 则 Keep；过了则 `StartupNoInput`。ready 之后，距 `last_progress/ready_at/rtc_grace` 不足 idle，或任一 hold 满足 `active && now < until`，则 Keep。模式 `Off` 永远 Keep；无合法 idle 永远 `Observe(UnknownPolicy)`。
- `Activity` 顺序是 `Reply, Search, Command, Listening, Input, Recognition`，直接当 6 槽下标。不要重排。

`M/.../business_runtime.rs`

- `from_settings` 只接受模式字符串 `observe|enforce`。其它（含空、`off`）返回 `None`，等于功能不挂上。
- 设备门是 `search_enrollment::enabled("1", "allowlist", allow, room, "")`。名单是逗号分隔的完整 SN，`"*"` 不匹配，空名单不匹配。房间必须是 `sn-BJP003` + 14 位数字 + `-` + 1..20 位数字。
- 签票只认 `timeout_ms`（同上闭区间）和 `revision`（`cfg-` 加 1..20 位数字）。缺一则 `idle_ms=None`，`evaluate` 只观察，`startup_deadline()` 为 `None`。
- `startup_ms` 固定 `startup_participant::STARTUP_BUDGET_MS`（60_000）。
- `asr_speech` 只应由真实语音调用。它把 `CONNECT_TIMEOUT`（`stt_volc.rs` 10 秒）加 5 秒做成绝对截止，并 `progress` 一次。每个新调用都换 generation。`asr_final` 结束该 generation；只有仍落在该窗口内才再 `progress` 一次。窗口外或没有对应 speech 的 final 不续命。
- `activity_until` 在截止 Instant 未变时直接返回。变成 `None` 时 `end_activity`。这是“禁止轮询刷新”的机制。
- `input_frame` 只在 `sample_count > 0` 时 `first_frame`。它不调用 `progress`。全零 PCM 只要样本数大于 0 就会打开 startup，但不会刷新 idle。这是对的。
- `within_startup` 在 deadline 已过时不 poll 传入的 future。connect 和 publish 必须包在这里，因为它们发生在事件循环之前。
- `reply_startup_deadline` / `reply_deadline` 锚定首次预算和最后一帧真实 PCM，不锚定 tick。

`M/.../job.rs` 与 `pipeline.rs` 的接线（倾听池尚未提交）：

- `JobMeta.voice_idle`。`Runtime::from_env`。enforce 且没有 durable intent 时，主池调用 `CloseIntent::begin_business`，失败则 `observe_only`。倾听池不要复制这一支。
- 1 秒 `JobWake::Watchdog` 上 `evaluate`，仅 `Decision::Close` 跳出循环，然后走原收尾。
- pipeline 每拍：播放样本数变了才 `progress`；`Activity::Reply/Command/Search/Input` 传原来的绝对截止；VAD `active` 才 `asr_speech`；final 才 `asr_final`。主池没有倾听租约，`Activity::Listening` 在主池 pipeline 里没有被调用。

### 3.2 倾听池已有权威，不要另造 TTL

已提交 `W/.../listening_mode.rs`（HEAD `22ab1c31`）：

- `LEASE_TTL_MS = 15_000`，`MAX_SESSION_MS = 1_800_000`。
- `renew_lease`（约 126–140 行）：`until <= now` 或 `until - now > 15_000` 拒绝。同一 version 若 `until < lease_until` 拒绝。成功才写入 `lease_until`。它不恢复 `Paused`。
- `Enter`（约 209 行）把 `session_deadline = now + max_session_ms` 写一次。之后 `configure` 只改下次进入用的上限，不改已经写入的 `session_deadline`。
- `Exit`（约 243–258 行）回到 `Normal`，清 `session_deadline`，不清 `lease_until`。所以 hold 必须看 phase，不能只看 `lease_until > now`。
- `tick`（约 351–360 行）：未授权或 `now >= session_deadline` 就 `pause`。比较是严格的 `now < lease_until`。
- `FeedbackActive` 到 `feedback_deadline` 只回到 `Listening`，不结束租约。

已提交 `W/.../listening_runtime.rs`：

- 会话时钟是自己的 `anchor`，`now_ms()` 是 `anchor.elapsed()` 的毫秒。它不是 job 的 `t0`。截止必须换成 `anchor + Duration::from_millis(stored)` 这种 `Instant`，再交给 `activity_until`。把裸毫秒当成 job 毫秒，会差出 prebuild/进房那段时间。
- `control` 在非重复 `Enter` 时写 `entry_deadline = now + 5000`（约 203–204 行）。离开 `Entering` 就清掉。
- `tick`（约 340–348 行）在 `Entering` 且 `now >= entry_deadline` 时 `pause_unavailable`。

已提交 `W/.../listening_adapter.rs`：

- `lease()`（约 468–492 行）发 RPC，然后 `next_lease = now_ms + 5000`。
- `poll`（约 1112–1118 行）在会话仍活跃、没有在途 lease、且到了 `next_lease` 时再请求。这是既有 Brain 授权刷新，不是 watchdog。
- `Event::Lease`（约 942–953 行）用 `remaining = ttl_ms - received.elapsed()`，再 `renew_lease(revision, now + remaining, now)`。一次响应写一次绝对截止。watchdog 的 tick 不得再调用 `renew_lease`。
- 待进入：`pending_deadline = now + 3000`（约 613 行），提议 `deadline: now + 3000`（约 419 行一带）。这两个时刻在已提交代码里只决定命令拒绝，不决定房间生死。

### 3.3 预组装仍堵在已提交事件循环里

已提交 `W/.../job.rs` 459–479 行：用户轨到达后，在 `next_job_wake` 之外 `await` prebuild，然后才 `tokio::spawn` pipeline。这段 `await` 期间 1 秒 watchdog、断线、startup `evaluate` 都不跑。`pipeline_task` 仍是 `None`，所以即使把 `evaluate` 放进 `JobWake::Watchdog` 也等不到。

同文件 145–160 行：`Room::connect` 和 `publish_output_track` 在循环之前，没有截止。startup 的 60 秒包不住挂起的 connect/publish。

正确的最小形状：`tokio::spawn` 的任务内部再 `await` prebuild，调用方只保存 `JoinHandle` 并立刻回到 `next_job_wake`。`OwnedTask` 仍拥有 ASR，job 退出时 drop/abort 必须能取消这个任务。connect 与 publish 用已有的 `within_startup(startup_deadline, ...)`。不要再造第三个计时器。

主池 `M/.../job.rs` 已是这个形状（`within_startup` 包 connect/publish，watchdog 分支里 `evaluate`）。倾听池不要把主池 `job.rs` 整文件盖过来：W 的 `delete_room` 对 listening 有两次 2 秒尝试，M 没有这条参数。

### 3.4 schema 1 不能装成通用关房账本

已提交两边的 `CloseIntent::begin` 都只在 `search_canary::is_candidate(agent)` 且 `P003_ROOM_CLEANUP_V1=1` 时写 schema 1。`generation` 和 `deadline_ms` 来自 metadata 的 `search_canary`，不是 `voice_idle`。

W 的候选 agent 包括 `p003-search-listening-20261030`（`search_canary.rs` 的 `LISTENING_AGENT`）。`is_candidate` 为真不等于这间房已经有一份匹配窗口的记录。

`W/.../ops/search-canary/reconcile_rooms.py`：

- `read_record` 要求 `schema == 1` 且 `deadline_ms > 0`。schema 2、`deadline_ms == 0` 会被当成 `invalid`。
- `reconcile` 75–81 行：`state==active` 且 owner 还活着时，只有 generation、`expires_at_ms` 与当前 canary window 一致才保留。否则继续 ListRooms/DeleteRoom。

因此：把倾听租约或 `cfg-*` 写进这份队列，会让 reconciler 删除仍在服务的房间。主池 `begin_business` 写的是另一目录 `/var/lib/p003-business-cleanup`，schema 2，`deadline_ms=0`，并且要求 status `mode==business`。倾听池的 Python reconciler 不认这份记录。未部署那个独立 reconciler 时，schema 2 只是堆文件，不提供崩溃回收。本次不要调用 `begin_business`，也不要把它拷进 `room_cleanup.rs`。

活着的 job 在 `Decision::Close` 后跳出循环，已提交收尾已经 `close_intent.closing()`（若有）并 `delete_room(..., meta.listening.is_some())`。这次回收靠的是这条路径。没有 schema 1 记录不是“必须降级成 observe”的理由，也不是“必须改用 schema 2”的理由。

## 4. 最小接口

保留主池这两个类型的求值数学，不改 `evaluate` / `begin_activity` 的公式。

倾听侧只增加读接口。`now` 只用来比较，函数不得写 `lease_until`，不得把返回值算成 `now + 15_000`。

```text
ListeningMode::business_deadline(&self, now: u64) -> Option<u64>
  phase 是 Normal 或 Paused，或 !authorized(now) -> None
  until = lease_until.min(session_deadline)
  now < until 才返回 until

ListeningSession::business_deadline(&self, now: u64) -> Option<Instant>
  先取 mode 的 until
  phase == Entering 时 until = until.min(已保存的 entry_deadline)
  entry_deadline 缺失则 None（失败关闭，不要退回 15 秒租约）
  返回 anchor.checked_add(until 毫秒)

ListeningSession::business_exit_at(&self) -> Option<Instant>
  仅非重复、已认证 Exit 当时的 now
  重复 Exit、State、poll、tick 不得改写

Adapter::business_deadline(&self) -> Option<Instant>
  只转发 runtime.business_deadline(runtime.now_ms())
  不要并上 proposal / pending

pipeline 每拍，在现有 Reply/Command/Search/Input 之后：
  w.activity_until(Activity::Listening, adapter.business_deadline())
  if let Some(at) = session.business_exit_at() { w.progress(at); }
```

`activity_until` 对同一个 `Instant` 不换 generation。租约 RPC 成功后 `lease_until` 变晚，Instant 才会变，这是新的已接收截止，不是 tick 自增。phase 回到 `Normal`/`Paused`、租约到期或 session 到期时必须传入 `None`，否则旧 hold 会留到原来的 `until`。

`business_exit_at` 的 `progress` 用的是退出命令的旧 Instant。`progress` 取 max，同一 Instant 重复调用不会把 idle 再推迟一个周期。不要改成 `progress(Instant::now())`。

Search/Reply/Command 继续用主池已经在用的绝对截止，不要为倾听再包一层：

- Reply：`reply_startup_deadline` 在开轮时算一次；之后 `reply_deadline(initial, last_pcm)`。
- Command：`sent_at + DEVICE_RESULT_DEADLINE`，已 ack 则再乘 3。`DEVICE_RESULT_DEADLINE` 在 W `pipeline.rs` 已是 8 秒。
- Search：只读 `SearchSession::business_deadline()`。提交/取消/恢复当时写入一次 `Instant`；成功轮询不得把 `poll_until` 改成 `now+80s`。`busy`、dialogue JSON、未激活的 remainder 不是截止。W 已提交的 `search_tasks.rs` 还没有这个只读方法；若要加，只加读取和“命令开始时写一次”的发布，不要改搜索 HTTP 语义。
- Input：仅有序 PCM 已有的 begin/收流截止，再按主池 `input_transition_deadline` 给一次签过名的 idle。不要套到倾听 `Entering`。
- Recognition：只在 VAD `active` 时 `asr_speech`，final 时 `asr_final`。不要从 `listening.poll` 或静音帧调用。

`first_frame` 继续由非空样本帧触发一次。零振幅不是 `progress`。

## 5. 应延后或去掉的 hold

审查结束时，脏工作区里的 `Adapter::business_deadline_at` 把 `runtime` 截止和 `proposal.deadline`、`pending_deadline` 做了 `max()`。这是本次最该去掉的行为。

待进入：`pending` 存在而 `Enter` 还没被 `handle` 接受。phase 仍是 `Normal`，mode 的 `business_deadline` 为 `None`。本地 `pending_deadline = now+3000` 只是命令超时。Brain 不回时，房间应继续按 startup/idle 回收。给这 3 秒做房间 hold，会在 idle 只剩不到 3 秒时把空房延长。`pause_pending_entry` 之后更必须是 `None`。

提议：`proposal.deadline = now+3000` 同样不是 Brain 租约。`voice_transition` 布尔单独不能保房，这点是对的；不要用提议截止把布尔换成另一个保房来源。

`max()` 的具体错误：会话已经有更早的 `lease_until` 时，一个新的 3 秒提议会把 watchdog 截止推过已接收租约。合成必须不存在。若将来单独保留握手，也只能在“还没有任何 authority window”时使用，并且不能晚于已有租约或 `session_deadline`。本次连这个也不要做。5 秒是签票 idle 的下限，短握手期间本来就不会因为 idle 被关掉，除非房间在提议前已经静默了接近一整段 idle。那种情况就应该关。

`Entering` 不要直接用 mode 返回的租约。mode 的新读函数对所有非 `Normal`/`Paused` 且已授权的 phase 返回 `min(lease, session)`，`Entering` 也包括在内。runtime 必须再和 5 秒 `entry_deadline` 取 min。否则静默进入会占满最多 15 秒租约，而模式自己在 5 秒就会 pause。进入提示的 TTS 若真的在播，Reply/PCM `progress` 已经保房，不需要第二份租约。

退出不要保留 `Activity::Listening`。`Exit` 后 phase 是 `Normal`，`business_deadline` 必须为 `None`。退出时刻只做一次 `progress`。脏测试 `accepted_exit_is_real_input_but_duplicate_queries_cannot_extend_idle` 的方向是对的：退出 Instant 固定，重复查询不变。不要再把退出做成 `activity_until`。

不要新增：

- `business_exit_at` 以外的“退出后再给一个 idle”的第二路径。一次 `progress` 已经是签票 idle。
- 按 `feedback_duration_ms`（默认 12 秒）另开 hold。反馈阶段继续用同一份租约/session 截止。播放中的 PCM 走 Reply `progress`。
- 摘要请求、lease RPC 在途、`next_lease` 倒计时的 hold。
- 在 watchdog tick 里调用 `renew_lease`、`progress(now)` 或 `asr_speech`。

## 6. 反例

数字都相对倾听会话的 `now_ms`。签票 idle 取下限 5000，startup 60000。hold 的 `Instant` 用会话 `anchor` 换算后，再由 `activity_until` 换回 job 毫秒。

租约到期，tick 还没跑：

- `renew_lease(1, 15000, 0)`，已进入 `Listening`。
- `business_deadline(14999)` 是同一个 Instant（anchor+15000）。
- `business_deadline(15000)` 为 `None`，即使 phase 字段仍是 `Listening`。
- 若最后一次真实 `progress` 早于 10000，则 `evaluate(15000)` 是 `Close(IdleNoProgress)`，不是再给 5 秒。
- 反例：实现写成 `now <= lease_until`，或到期后仍返回旧 `Some`，房间会在授权已失效后继续 Keep。

轮询刷新：

- 对 `now = 100, 5000, 10000, 14999` 连续读取，返回的 `Instant` 必须按位相同。
- 反例：`anchor + now + 15000`。第二次读比第一次晚 4900 毫秒，静音被续成新租约。
- Brain 真响应才允许变晚：`renew_lease(1, 20000, 5000)` 成功后，新 Instant 比旧的晚 5000，且之后再读 100 次仍是这个新值。失败的同 version 更早 `until` 不得改变存储值。

session 上限：

- `configure(60000, ...)` 后进入。随后在 10000、20000、30000、40000、50000 成功 `renew_lease(1, now+15000, now)`。
- `business_deadline(50000)` 是 anchor+60000，不是 anchor+65000。
- `renew_lease(1, 70000, 55000)` 后读取仍是 anchor+60000。
- `business_deadline(60000)` 为 `None`。随后 `tick(60000)` phase 为 `Paused`。
- 反例：hold 只看 `lease_until`。30 分钟（或测试里的 60 秒）之后 Brain 仍在发 15 秒租约，房间被继续保住。已提交 `listening_core.rs` 的 `maximum_session_deadline_pauses_even_if_lease_was_refreshed` 已证明模式自己会 pause；watchdog 必须在 tick 之前就停止 hold。

退出：

- 未认证参与者的 `Exit` 不写 `business_exit_at`。
- 认证 `Exit` 在 `now=6000` 写入一次 anchor+6000。随后重复 `Exit` 和 `State` 读取结果不变。
- `business_deadline(6000)` 为 `None`。`lease_until` 即使仍是 15000 也不得再 hold。
- 100 次 `progress(同一个退出 Instant)` 后，idle 从 6000 起算，到 11000 关，而不是从最后一次调用起算。
- 反例：`Exit` 不清 hold；或每次 `poll` 把 `last_exit_at` 更新成当前 `now`。后者会把空房永久续上。

待进入与提议：

- 只有 `renew_lease`、phase 仍是 `Normal`：`business_deadline` 为 `None`。
- `pending_deadline = 3000`、Brain 无响应：读取仍为 `None`。到 3000 后 `pause_pending_entry`，仍为 `None`。
- `hold_voice_transition()` 且没有已进入的 phase：`None`。
- `proposal.deadline = 3000` 不得单独返回 `Some`，也不得把已有租约的 Instant 推晚。
- 反例：脏树 `business_deadline_at` 的 `max()` 链。`now=0` 时期限为 3000 的提议会在租约只到 1000 时把房间保到 3000。

进入：

- `Enter` 时 `entry_deadline=5000`，租约到 15000。
- `business_deadline(0)` 和 `business_deadline(4000)` 都是 anchor+5000。
- `business_deadline(5000)` 为 `None`。
- 反例：Entering 直接返回租约截止。静默进入被保住到 15000，而 `tick(5000)` 已经 pause。

普通静音与 ASR：

- 连续零样本幅度、长度大于 0 的帧只允许第一次 `first_frame`。`last_progress` 不变。
- VAD 未激活的 50 毫秒 tick 不调用 `asr_speech`，也不 `progress`。
- 一次真实 `active` 把 Recognition hold 定在该帧的 `now+15s`。语音结束后不再 `active`，这个截止不再往后移。10 秒时到来的 final 结束 hold，并只 `progress` 一次。15 秒之后的 final 不 `progress`。
- 反例：每个 pipeline tick 都 `asr_speech(now)`。无语音的房间每 15 秒续一次。

startup：

- 从 assignment 起 60 秒没有任何 `sample_count>0` 的帧：`Close(StartupNoInput)`。中途反复 `first_frame` 若第一次已经晚于 60 秒，仍然 Close。
- prebuild 在 60 秒时仍未结束：job watchdog 必须已经能 `evaluate`。这就是 prebuild 不能留在事件循环里的原因。
- connect 在 deadline 之前就已超过 deadline：`within_startup` 不得 poll 那个 connect。
- 反例：空的 `sample_count==0` 帧把 ready 打开，startup 被静默帧解除。

Search/Reply/Command：

- 同一个 Reply/Search Instant 连续 `activity_until` 1000 次，generation 不增加，过点即 Close。
- `busy=true`、dialogue JSON、未 `active` 的搜索 remainder：`business_deadline()` 为 `None`。
- 反例：pipeline tick 用 `Instant::now()+budget` 重写搜索或命令截止。

## 7. 测试清单

这些是设计合同，不是本次已执行的结果。脏树里已经出现同名测试的，实现完成前不能把它们的当前断言当成绿。

必须有、且应对准第 6 节：

- `business_hold_tracks_real_lease_without_polling_renewal_or_normal_state_hold`
- `business_hold_respects_session_cap_revocation_and_paused_state`
- `accepted_exit_is_real_input_but_duplicate_queries_cannot_extend_idle`
- `listening_lease_silence_and_exit_use_fixed_authority_times`（放在 runtime 集成侧可以，但不得要求 `progress(Instant::now())`）
- 提议/pending 的反例：`proposal` 与 `pending_deadline` 都不改变 `Adapter::business_deadline`。脏树里 `business_listening_lease_and_protocol_transitions_are_absolute_and_bounded` 后半段期望“accepted proposal handshake budget”，与本边界相反，应改成期望 `None`，而不是把 `max()` 留着去满足它。
- Entering 5 秒封顶，且 5000 时为 `None`，即使 `lease_until` 仍是 15000。
- `revoke` 后立即 `None`，不等待下一次 Brain 响应。
- FeedbackReserved / FeedbackActive 使用同一 `min(lease, session)`，不使用 `feedback_deadline` 作为更长的房间截止。
- 静音帧不调用 `progress`；非 active VAD 不调用 `asr_speech`。
- 重复 final 不 `progress`。主池 `recognition_final_returns_to_signed_idle_and_cannot_revive_without_speech` 已覆盖模型，移植时保留。
- prebuild 卡住时 `spawn` 在 200 毫秒内返回 JoinHandle，abort 能取消 prebuild 里的 ASR owner。
- `within_startup` 对已经过期的 deadline 不 poll future。主池已有此测试，搬模块时一并保留。
- 缺 `voice_idle`、坏 revision、idle 越界：`Observe(UnknownPolicy)` 且 `startup_deadline()==None`。
- 模式空字符串：`from_env`/`from_settings` 为 `None`，job 不调用 `evaluate`。
- schema 1 `begin` 的房间名/SID 校验测试保持。新增测试证明倾听路径不写 schema 2，也不把 `cfg-*` 写入候选队列。

不要用这些测试去推动额外机制：

- 为通过提议 hold 而保留 `max()`。
- 为通过崩溃回收而调用 `begin_business`。
- 为通过 SID 读回而把正常收尾改成 `room_verify`。

## 8. 审查期间看到的未提交树

这不是实现验收。审查开始后 W 的 `rust-worker` 变为已修改，并出现未跟踪的 `business_watchdog.rs`、`business_runtime.rs`、`room_verify.rs`。最初三个未跟踪文件与 M 的同路径文件 sha1 相同；随后 `business_runtime.rs` 又被加了倾听测试，不再与 M 相同。本报告不回滚这些文件。

与本边界一致、可以留下的方向：

- `voice_idle` 与原 `listening` 字段并存。
- enforce 不再调用 `begin_business`。`reconciler_healthy()` 只读 `P003_ROOM_CLEANUP_STATUS_FILE` 和现有 `health()`，没有第二套队列。
- `spawn_after_prebuild` 把 prebuild 的 `await` 放进已经 `tokio::spawn` 的任务。调用方的 `.await` 只等到 JoinHandle 被创建。
- `within_startup` 包住 connect 和 publish。
- `ListeningMode::business_deadline` 只读 `min(lease_until, session_deadline)`，Normal/Paused/未授权为 `None`。
- runtime 对 Entering 再与 `entry_deadline` 取 min。
- 认证且非重复的 Exit 把 `last_exit_at` 设为命令的 `now`。
- pipeline 后段用 `activity_until(Activity::Listening, adapter.business_deadline())`，并对 `business_exit_at` 调用 `progress`。
- Reply/Command/Search/Input/Recognition 的钩子与主池同形。VAD active 才 `asr_speech`。
- 常量只是把已有 60 秒、5 秒、30 秒、10 秒命名为 `pub`。不要在同一次改动里改这些数。

与本边界冲突、应拿掉再合入：

- `job.rs` 在 connect 失败、publish 失败、以及 `business.is_some()` 的正常收尾改走 `room_verify::delete_exact`。`from_env` 在 observe、以及 enforce 但签票非法时也返回 `Some`。于是未真正获得关房权威的房间也会离开倾听池原有的 `delete_room(..., listening=true)`（两次 2 秒，认证失败不重试）。`token.rs` 的 `room_list` grant 只为这条路径服务。本次延后整组。
- startup/publish 失败若确实需要删已创建的房间，调用现有 `delete_room`，不要新开 SID 读回。`room_verify` 自己的测试也写明 name delete 不是 CAS。
- `Adapter::business_deadline_at` 的 proposal/pending `max()`。
- `enforcing && (close_intent.is_none() || !reconciler_healthy())` 就 `observe_only`。这会让没有候选记录的倾听房永远不回收，从而诱使下次再引入 schema 2。活进程有 `delete_room` 就够。`reconciler_healthy` 只应表示“候选崩溃重试是否可信”，不应当成 enforce 总开关。没有 status 文件时，enforce 仍可关活房；只是进程崩溃后的残留与今天一样，不由这次新增。
- 5 秒卡死心跳从墙上时钟改成 `t0.elapsed()`。读写若在同一改动里一起换，语义自洽，但它不是租约的一部分。可以单独留下，不要再扩散到别的时间源。

`business_watchdog.rs` 若仍与 M 字节相同，就不要在倾听池里改它的测试和公式。倾听行为放在 `listening_*` 与一份很薄的 pipeline 调用上。

## 9. 部署条件

未满足就不要把模式设为 `enforce`。本次不能证明这些环境是否已在任一池子上打开。

- 先部署带钩子的二进制，但 `P003_BUSINESS_WATCHDOG_MODE` 保持未设置。未设置时 `from_settings` 返回 `None`，行为与现在相同。这是回滚开关，不依赖再发一版。
- 观察期设 `observe`，并只把目标 SN 写入 `P003_BUSINESS_WATCHDOG_DEVICE_ALLOWLIST`。日志里的 `Decision::Observe` 不是关房。
- 签票是 job metadata 的 `voice_idle`，与 `listening` 对象并列，不要从 listening blob 里猜 timeout。`timeout_ms` 5000..=300000，`revision` 为 `cfg-` 加数字。缺签票时即使模式是 enforce 也只观察，且没有 startup abort。
- `enforce` 前确认收尾仍调用 `delete_room(..., meta.listening.is_some())`，没有 `room_verify` 分支。
- 不创建 `/var/lib/p003-business-cleanup`，不把 `P003_ROOM_CLEANUP_DIR` 指向主池 business 队列，不部署 schema 2 reconciler 作为本功能的依赖。
- 已有候选房继续用 `P003_ROOM_CLEANUP_V1` 和原来的 `P003_ROOM_CLEANUP_DIR`。`P003_ROOM_CLEANUP_STATUS_FILE` 若要读，只能沿用现有 `health()`（120 秒内心跳、`pending/invalid/record_changed` 为 0、`remaining<=512`）。不要新写一份 status 格式。
- startup 60 秒、idle 签票、Brain 15 秒、session 30 分钟是四条不同的线。部署文档里不要把它们收成一个“房间超时”。
- 不要用主池工件覆盖倾听池。W 相对 `50bac0b` 的 Rust 在已提交树上没有差异；反馈分段修复在这个祖先里。整树覆盖会丢掉 W 独有的 listening 模块，或把 M 的删房路径带进来。

## 10. 实现时不要做的事

- 不要整文件替换 `job.rs`、`pipeline.rs`、`room_cleanup.rs`、`listening_adapter.rs`。
- 不要在插入 `activity_until` 时重排 ASR final、TTS 分段或反馈门。脏 diff 里给 final 加一条日志、给 `on_ordered_packet` 改返回样本数，都不是本功能所需；样本数只为了 `input_frame` 的非空判断，可以留，但不要改识别结果。
- 不要把 `begin_activity` 的参数当成“每次传入剩余 TTL”。倾听只走 `activity_until`。
- 不要在 `ListeningSession::business_deadline` 里调用 `tick` 或 `renew_lease`。读与状态迁移分开。pipeline 已经会 `poll`/`tick`。
- 不要为 `business_exit_at`、提议或 pending 再增加 watchdog `Activity` 变体。六个槽已经够。
