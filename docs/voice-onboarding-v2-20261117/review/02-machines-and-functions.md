# 状态机、函数落点与四项核定

当前 HEAD 的课是服务端状态机：`begin` 向脑端要 `missing`，`Session::next` 按 `age/gender/nickname` 选 `ask_*`，`audio_complete` 把 `question_speaking` 收成 `waiting_answer`，答对再选题。v2 把选题从这条链上拿掉。下面的状态机是 v2 分支；`v=1` 不进入这些状态。

合成数据只用「六岁」「我是女孩」「叫我星星」「不告诉你」「等一下」。不使用真实孩子原文。

## 1. 课级状态

```
idle --begin(未过租约)--> isolated
isolated --finish(now < lease)--> finished
isolated --cancel / 退出词 / pipeline Cancel--> cancelled
isolated --now >= lease 或 epoch >= expires--> expired
```

`isolated` 期间 `Session::active()` 为真。三个终态都把 `active()` 变成假，并关闭当前题栅栏。

终态之后：

- 同一 `request_id` 的重放返回第一次的下行，不写库。
- 新 `request_id` 的 `finish` / `cancel` / `question_*` / `audio_complete` 不再改变终态，不写库。
- `answer()` 直接返回空。
- 隔离结束后的下一句才允许进入现有普通聊天。教学三问的 utterance 不得在终态前掉进 `start_turn`。

`lease = begin 被接受时的工人单调钟 + 180_000ms`。脑端行保持今天的 `deadline = min(wall_now + 180_000, session.expires)`。两个钟任一到期都只走 `expired`。`finish`、`question_started`、`audio_complete`、答题和跳题都不改这两个数。

## 2. 单题状态

每一题独立。课处于 `isolated` 时才接受题动作。index 必须是尚未出现过的下一个：第一题只能是 1。

```
announced --audio_complete(complete)--> window
announced --audio_complete(failed) | question_skipped--> closed
window --首个有效 ASR--> answering
window --question_skipped | audio 失败 | 课终态--> closed
answering --脑端回执且栅栏仍匹配--> closed + 发布 answer_result
answering --跳题/下一题/课终态先落地--> closed，吞掉晚到回执
```

`announced` 与 `closed` 与 `answering` 都算挡住资料输入：`blocks_input()==true`。只有 `window` 不挡。退出词在 `route_input` 里仍先于挡门，行为保持。

挡门期间 `speech()` 不得把 `speech_seen` 设为真。`poll()` 在挡门时清 `speech_seen` 的现有语句保留。打开 `window` 的那一次状态变化必须清 `speech_seen`，避免把播音回声留进回答窗。

### 2.1 answered

前置：`phase==window`，`speech_seen==true`，文本非空，题栅栏仍是这一题。

工人 `answer()` 把 `field` 按 index 写死后发给脑端，并带上当前 `question_revision`。本地进入 `answering`，立刻挡门。同一窗口内后续 ASR 全部丢掉，不进普通聊天，也不再发第二次脑端 `answer`。

脑端事务内：

1. 重读 `question_state`。index、revision、phase 必须仍是这次 `answer` 提交时的窗口，且 `write!=committed`。否则不更新 `family_member`，回 `answer=failed`、`memory=none`，`error` 用现有冲突风格即可。
2. `extractAnswer` 不变。拒绝短语 → `declined` + `skipped`，不写列。闲聊请求、半岁、日期、非姓名 → `unrecognized` + `none`，不写列。
3. 只有 `value` 才执行第 3 节的单列更新。`changes==1` 才把 `write` 改成 `committed`，回 `accepted` + `saved`。否则回滚，回 `accepted` + `failed`。
4. 不把课 `closed` 设为 1。今天 `declined` 会 `UPDATE ... SET closed=1`，v2 禁止。课继续等下一题。

工人只在回执的 index/revision 仍等于本地栅栏时发布 `answer_result`。发布后该题 `closed`。不调用 `Session::next`，不带下一句 cue。

识别结果不阻塞端侧。端侧可以在收到 `accepted` 后立刻 `question_started` 下一题，不必等它关心 `memory`。服务端仍以事务结果填 `memory`，但晚到的发布若栅栏已经变了，就按第 2.3 节吞掉。

### 2.2 skipped

`question_skipped` 与 `audio_status=failed` 走同一关闭。

工人先把本地题态改成 `closed` 并挡门，再向脑端发 `skip`。不要 `abort` 已经发出的 `answer` HTTP。今天 `Runtime::apply` 在新的 `Effect::Brain` 上会 `pending.take().abort()`，那只取消工人侧任务，取消不了脑端已经收下的事务。

脑端 `skip` 事务：

- 不调用 `extractAnswer`。
- 不执行任何 `UPDATE family_member`。
- 若该题 `write!=committed`：把 `question_state.phase` 写成 `closed`，回执 `memory=skipped`。
- 若该题已经 `committed`：只确认题已关闭，回执 `memory=none`。不把 `age_years` / `gender` / `nickname` 改回旧值。
- 同一 `request_id` 已有 receipt：比较哈希，相同则返回原 JSON，不同则 `request_conflict`。两次都不再写画像。

跳题不是课终态。index 1 跳过之后仍接受 index 2。

### 2.3 late-save

「迟到」指栅栏已经离开该题之后才出现的识别、脑端回执或写入企图。包括：旧 index、旧 `question_revision`、旧 `lesson_id`、旧 `trace_id`、非可信工人、重复的旧 `audio_token` 路径。

处理：

- 工人 `answer()` 在题不是 `window` 时返回空，不发 HTTP。
- 脑端写入语句放在重读栅栏之后。栅栏不匹配则语句不执行。
- 工人 `brain_reply` 在本地栅栏已变时不发布下行，不增加 revision，不改 `speech_seen`。
- 若 `answer` 事务比 `skip` 先提交：这一题的孩子列可以留下。这是跳题前已经说出口并先落库的答案，不是把旧答案写到新题。工人仍不得发布一条会让端侧退回旧题或重播问句的状态。
- 若 `skip` 事务先提交：后到的 `answer` 看到 `phase=closed`，画像字节不变。
- 禁止为了「也许写进去了」再发一个新 `request_id` 的补偿 `answer`。超时后的未知结果用 `failed` + `none`，不报 `saved`。

现有 `voice_onboarding_receipt` 仍是幂等源。补偿重试如果复用同一个 `request_id` 且字节相同，只会取回第一次的回执。

## 3. 写入边界

只更新 `snapshot.child.id`，并且 `account_id` 等于绑定的孩子 `account_id`。`changes` 必须为 1。家长 `account_id` 不得命中。

| 题 | SQL 只允许动的列 |
|---|---|
| 年龄 | `age_years`，`age_observed_at`，`updated_at` |
| 性别 | `gender`，`updated_at` |
| 昵称 | `nickname`，`updated_at` |

年龄值仍是 `extractAnswer` 今天给出的 1..=25 整数。`birthday` 不在 SET 里。已有 `birthday`（含空串和 `2018-08` 这种年月）保持原字节。不要因为写入了 `age_years` 而清空生日；`upsertProfile` 在生日非空时会清 `age_years`，所以这条路径不能走。

性别仍只收「男孩/女孩」及其现有同义词，落库「男孩」或「女孩」。昵称仍走现有汉字/字母规则。`c462462b` 的等待、重说、没听清短语继续返回 `unclear`，v2 映射为 `unrecognized`，不落库。

不插入新的 `family_member`。孩子行不存在或绑定不再唯一时，沿用 `binding_unavailable` / `ambiguous_child`，`memory=failed` 或 `none`，不编一份档案。

家长行的 `nickname`、`birthday`、`gender`、`age_years`、`age_observed_at`、`updated_at`，以及画像列 `interests`、`preferred_address`、`personality_notes`、`recent_emotion`、`game_progress`，在整课前后字节相同。孩子行未被本题点名的列同样不动。

`missing()` 今天把孩子行和家长行合在一起判断缺项，`begin` 再把缺项交给 `Session::next`。v2 的 `begin` 不返回缺项，不调用 `missing()` 来决定问什么。家长有昵称、孩子已有年龄，都不能让服务端少收一题。

## 4. 180 秒与 finish 的互斥

今天的冲突点：

- `Session::deadline` 是 `started + 180_000`。
- `Session::control` 在识别 action 之前调用 `tick`。`tick` 在到期时 `end("failed")` 并直接返回。同包里的 `finish` 不会被记成完成。
- `Session::end` 对非 `failed` 一律 `memory_write=skipped`，并且 `finish` 与 `cancel` 都写 `stage=completed`。
- `VoiceOnboardingStore.step` 在 `now >= deadline` 时连 `close` 也抛 `expired` 410。
- 脑端 `begin` 把 deadline 收成 `min(now+180_000, expires)`，之后不再延长。这一点保持。

v2 规定同一课只有一次终态迁移。

| 先发生 | 后发生 | 结果 |
|---|---|---|
| `finish` 时两个钟都未到 | 之后的 `tick` | `tick` 看见已终态，返回空。不得再发 `failed` |
| 任一钟先到 | `finish` | 终态已是 `expired`。`finish` 只回这条已到期回执，不改成 `finished`，不写库 |
| 同一包里 `now >= lease` 且 action 是 `finish` |  | 只走 `expired`。不要先 `end("failed")` 再处理 `finish` |
| `finish` 时 `now < lease` |  | 只走 `finished`。deadline 数字不变 |

实现时 v2 的 `control` 不要复用「先 `tick` 再匹配 action」。对 `finish` 用严格小于比较租约；其它 action 仍先看租约，到期则只发一次 `expired`。

`finish` 不播放 4A/4B，不发 `complete_exit` / `quiet_exit`，不把 `memory` 写成 `skipped`。今天 `end()` 的 skipped 会把前面已经 `saved` 的课级状态盖掉。v2 课级回执的 `memory` 固定 `none`。

`cancel` 与 `begin_session_exit`、pipeline 的 `Inbound::Cancel` 都进 `cancelled`，不得调用现在的 `Session::cancel` → `end("completed")`。3C 若误发 `finish`，服务端无法分辨有没有播完结束语；合同要求 3C 发 `cancel` 或不发教学终态。验收时把误发 `finish` 记成端侧缺陷，不在服务端猜。

到期后的脑端 `close(reason=expired)` 若得到 410，工人保持 `expired`，不升级成失败，不重试写入。410 不是第二次终态。

## 5. 重复 audio_complete 不得再吞 fresh VAD

`c462462b` 的修复在 `Runtime::control`：只有 `revision`、`active`、`blocks_input` 三者有变化才清 `speech_seen`。缓存重放不改变这三项，于是等待中的 ASR final 还在。对应测试是 `runtime_duplicate_audio_receipt_preserves_fresh_speech_but_new_cue_does_not`。

v2 必须保留这个比较，不能改回「每次 `control` 都清 `speech_seen`」。

- 同一 `audio_complete` 字节的重放：`requests` 命中在前，状态三项不变，`speech_seen` 保持。此时 `reject_asr()` 仍为假。
- 真正打开窗口的第一次 `audio_complete`：`blocks_input` 从真变假，必须清 `speech_seen`。窗内没有新的 VAD 时，`route_input(..., fresh_speech=false)` 仍是 `Drop`。
- 下一题 `question_started`：重新挡门并清 `speech_seen`。上一题的 VAD 不能算这一题的 fresh speech。
- 旧题重放、错 index、错 lesson、错 trace：今天 `retired_audio_and_old_revision_do_not_advance` 的「状态不变」要继续成立。

`route_input` 的四个优先级不要为 v2 重排：未激活 → `Ordinary`；退出 → `Exit`；挡门或没有 fresh speech → `Drop`；否则 → 只交给教学 `answer()`。最后一支在 v2 里不得再落进普通 `start_turn`。今天 `on_final` 对 `Ordinary` 会继续走字幕和 turn gate，要到 commit 附近才 `return`。v2 在 `active()` 时，`on_final` 的教学分支必须在调用普通 commit 之前结束。`waiting_exit` 那条「答完不 return、随后 `end(normal_chat)` 把 `active` 清掉、再掉进聊天」的路径是 v1 的，v2 没有 `waiting_exit`。

## 6. 能力失败时的隔离边界

没有 metadata 时 `Runtime::from_metadata` 返回 `None`，pipeline 的 `onboarding` 就是 `None`。这时房间就是普通聊天。v2 不要在这个状态下拦截所有音频，否则会把未教学的普通会话变成哑巴。

因此「没协商成功」的本地课是端侧义务：端侧不把三问答案送进房间。服务端验收只要求零 receipt、零画像改写、零 `answer_result`。

`begin` 已经被接受之后，脑端超时、410 以外的存储错误、单题 `failed`，都不得调用今天的 `brain_failure` → `end("failed")`。那个函数会把 `active()` 清掉，下一句就会进 `start_speculation` / `start_turn`，教学被普通聊天抢走。v2 单题失败只关该题，课继续 `isolated`，直到 `finish`、`cancel` 或租约到期。

`pipeline.rs` 里 begin 的 9 秒推迟是 v1 为了不吞掉提前唤醒的首句。推迟表只存第一包，9 秒到了直接 `None`，而客户端 3 秒重发在这 9 秒内又因为「已经 deferred」被忽略。结果是 begin 丢失，隔离从未开始。v2 的 `begin` 不再进入 `onboarding_deferred`。收到可信 `begin` 就 `control()`，并 `hard_abort_current` 掉正在说的普通轮。begin 之前已经进普通路径的那句，不追认为第 1 题答案。

`Session::control` 的 `listening==true` 今天会 `end("completed")`，但 pipeline 两处调用都写死 `false`，这个参数是死的。v2 不要把它接回 `finished`。倾听会话仍在签发时被 `voiceOnboardingEligible` 排除。

## 7. 逐函数最小改动

只列需要动的函数。没点名的函数不改。

### 脑端

`voiceOnboardingEligible`：在现有闸门通过后，若 `supports` 含 `voice_onboarding_v2` 返回 2，否则若含 v1 返回 1，否则 0。不要拆第二套环境变量。

`issueVoiceOnboarding`：按模式把 `version` 放进 `issue()` 的返回值。撤销旧行的 SQL 保持，且仍只在 devices 库已有表时执行。模式 0 继续返回 null。

`VoiceOnboardingStore.issue`：返回版本改为入参，不再写死 1。不读画像来决定题目。

`VoiceOnboardingStore.missing`：v2 不调用。v1 保持「孩子或家长任一有值就算已知」。不要为了 v2 去改这个函数的 v1 语义。

`extractAnswer`：不改规则，不加模型。v2 只把 `unclear` 映射成下行 `unrecognized`。

`stepSchema` / `VoiceOnboardingStore.step`：v1 对象保持 strict。新增 v2 分支：

- `begin`：写 `lesson_id` 与 deadline，`question_state` 留空，`memory=none`。不计算 `missing`。
- `answer`：按第 2.1 节做栅栏和单列更新。
- `skip`：按第 2.2 节，零画像写入。
- `close`：`closed=1`，`memory=none`。不碰画像。到期的 close 允许返回 410，调用方不得据此重写。

`createVoiceOnboardingRoute`：解析前看 `v`。鉴权块不动。错误体继续带 `memory_write:"none"`，避免失败被客户端当成保存成功。

`device-session.ts` 签发段：metadata 与 `voice_onboarding_contract` 使用同一个 version/capability。不要一边是 1、一边是 2。

`buildOnboardingGuide`：不改。禁止从 v2 `step` 或工人答题路径调用它。

`profile-store.ts` 的 `upsertProfile`、`upsertBasics`、`copyProfile`、`updateMemoryFields`：v2 不调用。家长到孩子的三字段拷贝会把家长生日写到孩子身上，和「不编生日、不碰家长字段」冲突。

### 工人

`Runtime::from_metadata`：`version==1` 维持现构造；`version==2` 构造 v2 会话。其它版本继续 `None`。grant 长度和 endpoint 拼法不变。1800ms HTTP 超时不变。

`Session::trusted_origin` / `control`：按会话版本检查 `v`。v2 动作表换成第 1 节。幂等查表必须仍在 `seq` 单调检查之前。

`Session::tick`：v2 只产生一次 `expired`，`memory=none`，不发 cue。

`Session::end`：v1 可留。v2 不要用它同时表达 finish、cancel 和失败。拆成三个终态函数，都禁止附带 `audio_prompt`。

`Session::cancel`：v2 改为 `cancelled`，供 `Runtime::cancel`、退出词和 pipeline Cancel 使用。

`Session::next` 与 `emit` 的 cue 参数：v2 不调用 `next`。v2 下行构造单独写，避免再拼 `v398_{n}_{uuid}` 令牌。

`Session::answer`：v2 增加 index/revision/field，且窗口不开放时返回空。

`Session::brain_reply`：v2 先对栅栏。不匹配则空。匹配时只发布 `answer_result`。不要再按 `missing` 调用 `next`。`declined` 不结束课。

`Session::brain_failure`：v2 改为当前题 `failed` + `memory=none`，课保持 `isolated`。不要 `end("failed")`。

`Session::blocks_input`：v2 在 `announced`、`answering`、题间 `closed` 且课仍 isolated 时为真；仅 `window` 为假。

`Runtime::control`：保留三项比较才清 `speech_seen`。

`Runtime::apply`：v2 不得在 `skip` 或 `close` 时 abort 在途 `answer`。允许回答任务自己结束；结束时再走栅栏。`skip` 用另一个请求发出去。

`Runtime::poll`：到期仍只产生一次终态。HTTP `None` 在 v2 走单题失败，不拆隔离。挡门时清 `speech_seen` 的语句保留。

`route_input`：函数体不改。调用方保证教学窗内的 `Ordinary` 不会进 LLM。

### pipeline 与入口

`pipeline.rs` 初始化 `from_metadata` 的那一行：继续只读 job metadata。不读设备自述版本。

音频循环里 `blocks_input` 时清 VAD 缓冲并 `continue` 的段落保持。`speech()` 仍只在 VAD 过阈值且教学存在时调用。

`on_interim`：`reject_asr` 时返回的语句保持。

`on_final`：v2 且 `active()` 时，`Drop` 返回；`Exit` 走现有 `begin_session_exit`；资料句只留给 commit 侧的 `answer()`，不进搜索和投机。更小的改法是在现有 commit 段去掉 v2 的 `was_exit` 落穿，并在 `start_turn` 之前 return。不要新开一条识别器。

`on_control` 的 `VoiceOnboarding`：v2 的 `begin` 不写入 `onboarding_deferred`，直接 `control` 并打断当前普通轮。`finish` 与 `cancel` 仍清 deferred。

`begin_session_exit`：继续调用 `cancel()`，但 v2 的 `cancel` 必须是 `cancelled`。

`on_tick_inner`：v2 不执行「9 秒后把 deferred begin 丢掉」。v1 的 9 秒行为不动。

`start_speculation` 与 `start_turn` 开头的 `active()` 返回保持。这是隔离的最后一道门，单题失败不能把 `active()` 清掉。

`control.rs` 的 `parse`：不改类型名。v2 仍是 `Inbound::VoiceOnboarding`。

`job.rs` 的 `JobMeta.voice_onboarding`：不改字段名。metadata 里的 `version` 由 runtime 解释。

`tools/onboarding-entry-tests/src/lib.rs`：继续把生产 `voice_onboarding.rs` 引进去测。v2 用例加在这里和现有 `voice_onboarding_tests.rs`，不要另做一套只存在于文档里的假工人。

## 8. 真实边界

- 服务端不能证明 4A/4B 已经出声。`finish` 不等于验收过的本地完成位。
- 180 秒是隔离上限，不是端侧完成条件，也不是重上课指令。
- 没 grant 的房间会把送来的音频当普通聊天。这不是服务端再加一个静默课能安全补上的。
- 在途 `answer` 若已提交，跳题不回滚。回滚才会把孩子刚说对的年龄删掉。
- 工人 1800ms 超时与脑端稍晚提交可以同时发生。对外不报 `saved`，库内以 receipt 为准。不要做第三次请求去「查清楚再补写」。
- 普通聊天补问在隔离结束后仍会出现。这是附件要求保留的记忆系统，不是教学重问。
- 本文件不授权改端侧。端侧顺序、5 秒静默、4A/4B 选择和本地完成位仍由客户端实现。服务端只冻结上面的回执。
