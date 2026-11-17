# v2 必须验收用例

给主 13 固定新 SHA 之后执行。本审查没有跑这些用例。v1 的 Brain 21/21 与 Worker 39/39 仍以 `docs/voice-onboarding-20261117/ROOT-ACCEPTANCE.md` 的已记录结果为准；新 SHA 必须重跑那两组，并加上本文。

数据只用合成账号、合成 SN、合成 trace。不读生产库，不打印 grant、token、真实昵称或生日。年龄例用「六岁」，性别例用「我是女孩」，昵称例用「叫我星星」。

通过标准写在每条末尾。未写的观察项不算通过。

## A. 协商与 v1 共存

A1. supports 只有 `voice_onboarding_v1`，其余闸门通过。响应 `voice_onboarding_contract.version==1`，metadata `version==1`。随后走现有缺项选题，不接受 `v=2` 载荷。

A2. supports 只有 `voice_onboarding_v2`。响应和 metadata 都是 version 2、capability `voice_onboarding_v2`。`missing()` 不被调用来选题。

A3. 同时带 v1 和 v2。只签发 v2。不出现第二份 v1 合同。

A4. 总闸关闭、SN 不在名单、倾听会话、搜索金丝雀，四种各一次。响应没有 `voice_onboarding_contract`，metadata 没有 `voice_onboarding`。不新建可写的教学行。devices 库若尚无教学表，也不为了这次请求建表。

A5. 无 grant 的工人收到 `v=2` 的 `begin`。不产生 state，不产生 receipt，`family_member` 字节不变。

A6. 现有 v1 测试全绿，包括非姓名负例不落库，以及 `runtime_duplicate_audio_receipt_preserves_fresh_speech_but_new_cue_does_not`。

## B. 三题 answered

公共前置：v2 grant，`begin` 已接受，家长行有昵称、性别和生日，孩子行三列为空，`birthday` 为空串。服务端仍必须收满三题。

B1. `question_started(1)` 后、`audio_complete` 前，送「六岁」。无脑端 `answer`，孩子 `age_years` 仍为空，无下行 `answer`。

B2. 第 1 题 `audio_complete(complete)` 之后，fresh VAD 再送「六岁」。下行 `answer=accepted`、`memory=saved`、`question_index=1`。孩子 `age_years=6`，`age_observed_at` 非空，`birthday` 仍是空串。家长行整行不变。下行没有年龄数字。

B3. 第 2 题同样过程送「我是女孩」。只改孩子 `gender=女孩`。年龄列保持 B2。家长性别不变。

B4. 第 3 题送「叫我星星」。只改孩子 `nickname`。家长昵称不变。三题之后服务端不发第 4 题，不发 `complete_exit`。

B5. 孩子行事先已有昵称。第 3 题仍接受，新的有效昵称覆盖孩子 `nickname` 一列。服务端不因「已有资料」拒绝或跳过。

B6. 同一 `audio_complete` 的回答窗里连送两句有效年龄。只有第一句产生 receipt 和列更新。第二句不写、不进 `start_turn`。

## C. skipped

C1. 第 1 题打开窗口后不送语音，直接 `question_skipped`。孩子三列不变。该题回执 `memory=skipped`。课仍 isolated。随后第 2 题可以开始。

C2. 同一 `question_skipped` 字节再投递两次。receipt 仍是 1 行，画像更新次数为 0，revision 不增加。

C3. 同一 `request_id` 但改一个字段。返回冲突，画像不变，题保持第一次跳题后的关闭态。

C4. `audio_status=failed`。与 C1 相同：关窗、不写、不结束课。

C5. 第 1 题 `declined`（「不告诉你」）。`answer=declined`、`memory=skipped`，不写列，会话 `closed` 仍是 0。第 2 题和第 3 题仍可进行。这是相对今天「declined 会把整课 closed」的 v2 差异。

C6. 「等一下」「再说一遍」「没听清」在第 3 题。`answer=unrecognized`、`memory=none`，昵称列不变。不发重问 cue。

## D. late-save

D1. 第 1 题窗口内先发出脑端 `answer`，在事务提交前让 `skip` 拿到写锁。`answer` 提交时看到 `phase=closed`，`age_years` 不变。工人不发布可推进的 `answer_result`。

D2. 反过来：`answer` 事务先提交，再处理 `skip`。`age_years=6` 保留。`skip` 回执 `memory=none`。工人不再发一条让 index 回到 1 或重播问句的状态。第 2 题的写入不得改到年龄列。

D3. 第 2 题已经 `question_started` 之后，投递第 1 题的旧 ASR 和新 `request_id`。不写昵称或性别，不发布 index=1 的推进。

D4. 旧 `lesson_id`、旧 `trace_id`、错误设备 identity、`src` 不是 android。四种都无状态迁移、无写入。

D5. 工人对同一回答窗超时后，不得用新 `request_id` 再 POST 一次 `answer`。对外不得出现 `memory=saved`，除非第一次 receipt 里已经是提交成功。

## E. fresh VAD

E1. 第 1 题第一次 `audio_complete` 后，`speech()` 一次，`reject_asr()` 为假。把同一 `audio_complete` 再投递。`speech_seen` 仍在，`reject_asr()` 仍为假，revision 不变。

E2. 没有新的 `speech()` 时，窗口内的 final 被 `route_input` 丢掉。画像不变。

E3. 第 2 题 `question_started` 后，第 1 题留下的 `speech_seen` 不得使第 2 题 `reject_asr()` 为假。必须有第 2 题窗口打开之后的新 VAD。

E4. 播音挡门期间的 VAD 不调用有效 `speech()` 记账。挡门结束当帧不得直接变成答案。

## F. 180 秒与 finish

时钟用注入的 `now`，不要真的睡 180 秒。

F1. `begin` 后 deadline 与 lease 固定。中间插入三题、跳题和 `audio_complete`，两个截止点的毫秒值不变。

F2. `now = begin + 179_999` 送 `finish`。终态 `finished`，`memory=none`。随后 `tick(begin+180_000)` 不再产生 `failed` 或第二份终态。画像相对 finish 前不变。

F3. `now = begin + 180_000` 的第一包就是 `finish`。终态只有 `expired`，不是 `finished`，也不是 v1 的 `stage=failed`。无 cue。再重放 `finish`，终态不变，无新写入。

F4. 先 `expired`，再来一个新 `request_id` 的 `finish`。不把 `expired` 改成 `finished`。

F5. 租约内 `cancel`，以及退出词触发的 `begin_session_exit`。终态 `cancelled`，不是 `finished`。`memory=none`。

F6. `finish` 与 `cancel` 的下行都不含 `audio_prompt`、`complete_exit`、`quiet_exit`。

F7. 脑端在 deadline 之后收到 `close(reason=expired)` 返回 410。工人保持 `expired`，不补写，不再发 `failed`。

## G. 生日与家长

G1. 孩子 `birthday` 预设为 `2018-08`。第 1 题接受「六岁」后，`birthday` 仍是 `2018-08`，`age_years=6`。不得变成某个完整日期，也不得被清空。

G2. 第 1 题送「2018年8月」或「六岁半」。`unrecognized`，`birthday` 与 `age_years` 都不变。

G3. 家长 `birthday`、`nickname`、`gender`、`age_years`、`updated_at` 在 B2–B4 全流程后与开课前逐列相同。

G4. v2 `step` 的调用栈不得进入 `copyProfile`、`upsertBasics`、`upsertProfile`。用测试桩或调用计数即可。

G5. 更新语句若匹配到家长 id，必须失败且回滚。构造一条错误 id 的内部用例：`memory!=saved`，两行都不变。

## H. 隔离与失败

H1. `begin` 到达时房间里已有普通 agent turn。v2 立即进入 isolated，并打断该轮。该 begin 不得只放进 9 秒 deferred 后被丢弃。

H2. 第 1 题脑端 HTTP 失败或 `brain_failure`。下行 `answer=failed`、`memory=none`，课仍 `active`。下一句资料音频不进 `start_turn`，不进 `start_speculation`。

H3. isolated 期间的最终识别不调用搜索、不发教学 TTS、不跑 `buildOnboardingGuide`。

H4. `finished` 之后的下一句可以进入普通聊天。此时现有缺资料引导允许出现。这句不再写教学 receipt。

H5. 单题 `failed` 之后端侧发第 2 题。第 2 题仍可 `saved`。整课不因第 1 题失败而关闭。

## I. 绑定

I1. 每条被接受的 v2 下行都有 `v=2`、trace、session、lesson、request、question_index、revision。revision 只在新状态下严格加一；重放保持原 revision。

I2. 下行 JSON 键集合不得包含 `text`、`value`、`nickname`、`birthday`、`age_years`、`gender`、`grant`、`token`、`audio_prompt`、`audio_token`、`missing`。

I3. index 3 之后再 `question_started(1)` 或 `question_started(4)`。丢弃，不写，课终态不变。

I4. `request_exit_prompt` 打到 v2 会话。丢弃，不发 `quiet_exit`，不结束课。

## 执行位置

- 脑端 HTTP 与 SQLite：沿用 `apps/server/scripts/voice-onboarding*.test.ts` 的真实路由和 `DatabaseSync`，不换内存假库。
- 工人状态机：`rust-worker/src/voice_onboarding_tests.rs`。
- 入口隔离：`rust-worker/tools/onboarding-entry-tests`，继续引用生产 `voice_onboarding.rs` 与 pipeline 里实际调用的函数。不新做一套平行状态机。

下一 SHA 的验收回执要写明：本文编号哪些过了，v1 21 与 39 是否仍过，以及没有部署。未跑到的编号保持未验，不要记成通过。
