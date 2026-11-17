# v2 接口冻结建议

对照当前实现阅读。v1 行为的来源是：

- `2-Projects/P003GameDemo20260513/apps/server/src/voice-onboarding-runtime.ts`
- `2-Projects/P003GameDemo20260513/apps/server/src/voice-onboarding-store.ts`
- `2-Projects/P003GameDemo20260513/apps/server/src/routes/voice-onboarding.ts`
- `2-Projects/P003GameDemo20260513/apps/server/src/routes/device-session.ts` 的 `issueVoiceOnboarding` 调用和响应展开
- `2-Projects/realtime-voice-agent/rust-worker/src/voice_onboarding.rs`
- `2-Projects/realtime-voice-agent/rust-worker/src/pipeline.rs` 的 onboarding 入口
- `2-Projects/realtime-voice-agent/rust-worker/src/control.rs` 的 `voice_onboarding.request` 解析
- `2-Projects/realtime-voice-agent/rust-worker/src/job.rs` 的 `JobMeta.voice_onboarding`

## 1. 能力协商

沿用 `POST /v1/device/session`。不新增 Godot 直连地址，不改 401。

`device-session.ts` 已把 `body.supports` 收成最多 16 个、每个最长 64 的字符串。这个限制够用，不要放大。

`voiceOnboardingEligible` 今天的闸门全部保留：`VOICE_ONBOARDING_ENABLED=1`、普通池、非倾听、`VOICE_ONBOARDING_WORKER_AGENT` 精确匹配、`VOICE_ONBOARDING_SN_ALLOW` 命中，且 `supports` 含 `voice_onboarding_v1`。

最小改法：把布尔改成模式，闸门只算一次。

| supports | 其它闸门 | 签发 |
|---|---|---|
| 含 `voice_onboarding_v2` | 通过 | 只发 v2 |
| 不含 v2、含 `voice_onboarding_v1` | 通过 | 只发 v1，字节语义与 HEAD 一致 |
| 都不含，或闸门不过 |  | `issueVoiceOnboarding` 返回 null |

同时带 v1 和 v2 时只发 v2。新客户端应只声明 v2。v398 继续只声明 v1。不要给 v398 补声明 v2。

不要新增第二套 SN 名单或第二把总闸。倾听池、搜索金丝雀池今天已经因为 `listening` / `normal:!canary.canary` 拿不到教学授权。v2 继续不进这两池。

签发成功时，响应体和 JWT `agents[0].metadata.voice_onboarding` 必须是同一个版本：

```json
{"version":2,"grant":"<64位十六进制>","expires_at_ms":0}
```

响应同层：

```json
{"voice_onboarding_contract":{"version":2,"capability":"voice_onboarding_v2"}}
```

`issue()` 的 grant 生成、`digest(grant)` 入库、新会话把同 SN 旧行 `closed=1` 都保持。不要在默认关闭路径上初始化画像库；`issueVoiceOnboarding` 里「库文件不存在就跳过撤销」的分支保持。

未签发时：响应里不要出现 `voice_onboarding_contract`，metadata 里不要出现 `voice_onboarding`。这不是把 v398「没合同就释放教学、继续普通聊天」改写成新规则。那句只对仍跑 v1 的 v398 有效。新客户端在没有 v2 合同，或 `begin` 没有被接受时，自行把三问和 4A/4B 播完，并且不把答题音频送进开放对话。服务端在没有 Runtime 时做不到隔离，也不得为此造一个会写库的假课。没有 grant 的 `v=2` 控制包会被工人忽略，脑端不会出现 receipt，画像不会被教学路径改写。

## 2. 通道

不变：topic `control`，type `voice_onboarding.request` / `voice_onboarding.state`，lane `voice_onboarding`，`control::parse` 的 4096 字节上限和 `src=android`。

每个被接受的上行和下行至少带：

`v=2`、`trace_id`、`session_id`、`lesson_id`、`request_id`、`question_index`、`revision`

标识继续用现有 `valid_id`：1..128，仅字母数字、`_`、`-`。`question_index` 为整数。`revision` 为整数 0..1000000。

工人 `trusted_origin` 今天要求 `payload.v == 1`。v2 Runtime 改为只接受 `v == 2`。v1 Runtime 继续拒绝 `v == 2`。版本来自 metadata，不来自设备后来的自述。

## 3. 上行动作

客户端决定顺序。服务端不返回下一题，不返回 `audio_prompt` / `audio_token`，不合成题干或 4A/4B。

| action | question_index | 作用 |
|---|---|---|
| `begin` | 0 | 进入隔离。重复同一 `request_id` 幂等 |
| `question_started` | 1，然后 2，然后 3 | 宣布当前题。1 年龄，2 性别，3 昵称 |
| `audio_complete` | 与当前题相同 | 该题本地音频实际播完，才打开回答窗 |
| `question_skipped` | 与当前题相同 | 静默、无有效识别或回执超时。关闭该题 |
| `finish` | 当前题；尚未出题时为 0 | 端侧声称 4A 或 4B 已播完。只结束隔离 |
| `cancel` | 同上 | 用户退出、系统中断、未唤醒的 3C。不是完成 |

`entry` 仍只允许 `scheduled` / `early_wake` / `next_day`。v2 不再使用 `request_exit_prompt`。收到它时 v2 分支直接丢弃，不播 `quiet_exit`，不结束课。

`audio_complete` 继续带 `audio_status=complete|failed`。v2 没有服务端音频令牌，因此不再比较 `audio_token`。`failed` 只关闭当前题的回答窗，效果与该题 `question_skipped` 相同，不结束整课。缺文件不得由端侧报 `complete`。

`begin` / `finish` / `cancel` / `question_skipped` 不带答案正文。`audio_complete` 不带答案正文。

重发合同保持：同一字节每 3 秒一次，最多 3 次。幂等键是 `session_id + request_id`，哈希覆盖整份载荷。同键同字节返回第一次的下行，不第二次写库。同键不同字节返回冲突，不写库。这是今天 `voice_onboarding_receipt` 的行为，v2 继续用这张表。

## 4. 下行 answer_result

type 仍是 `voice_onboarding.state`。v2 载荷不再使用 v1 的 `stage` 选型机，也不再带 `audio_prompt`、`audio_token`、缺项数组、孩子原文或画像值。

```json
{"v":2,"session_id":"...","lesson_id":"...","request_id":"...","question_index":1,"revision":4,"answer":"accepted","memory":"saved"}
```

`request_id` 使用打开该回答窗的那次 `audio_complete`。旧题回执因此对不上新题的请求。

`answer` 只表示这一题的识别处理：

| answer | 含义 |
|---|---|
| `accepted` | `extractAnswer` 得到一个值，并且本次事务已决定是否落库 |
| `unrecognized` | 听不懂、闲聊请求、半岁、日期、非姓名。不追问 |
| `declined` | 命中现有拒绝短语。不追问 |
| `failed` | 脑端超时、存储错误或契约校验失败。不追问 |

`memory` 只表示这一题有没有提交画像：

| memory | 何时 |
|---|---|
| `none` | 这个动作没有提交写入 |
| `saved` | 同一事务里孩子行更新已提交之后 |
| `skipped` | 孩子明确拒绝，或跳题时该题没有任何已提交写入 |
| `failed` | 尝试更新且事务回滚，或更新行数不是 1 |

禁止用一个字段同时表示两件事。今天 `brain_reply` 把 `result=saved` 和 `memory_write=saved` 绑在一起，v2 拆开。

合法组合只有：

- `accepted` + `saved`
- `accepted` + `failed`
- `unrecognized` + `none`
- `declined` + `skipped`
- `failed` + `none`，或 `failed` + `failed`

`begin`、`question_started`、`audio_complete`、`finish`、`cancel` 的下行没有 `answer`。它们的 `memory` 固定 `none`。`question_skipped` 在该题尚未提交过写入时 `memory=skipped`；该题已经 `saved` 时，跳题回执仍是 `memory=none`，因为跳题动作自己没写，也不许把已提交的值改回空。

下行不得出现 `text`、`value`、`nickname`、`birthday`、`age_years`、`gender`、grant、token。

## 5. 课级终态

课级终态与逐题 `answer` 分开。工人内部只留一个：

| 终态 | 来源 | 端侧完成位 |
|---|---|---|
| `finished` | 租约内的 `finish` | 服务端不写。端侧已在 4A/4B 播完时自己持久化 |
| `cancelled` | `cancel`、退出词、工人侧会话取消 | 不是完成 |
| `expired` | 180 秒或会话 `expires` 先到 | 不是完成，也不命令重上课 |

3C（介绍后提醒，仍未唤醒）不得发 `finish`。服务端看不到端侧是否真的播了 4A/4B，所以 `finish` 的意思只是「端侧声称隔离可以结束」。服务端不设教学完成列。

终态下行使用 `terminal=finished|cancelled|expired`，`memory=none`。不要复用 v1 的 `stage=completed`。那个值今天同时被 `finish`、`cancel` 和 `Session::control` 的 `listening` 分支使用。

## 6. 与 v1 的隔离

`stepSchema` 今天是 `.strict()` 且 `action` 只有 `begin|answer|close`。不要往这个对象里加可选的 `question_index`。v2 用带 `v:2` 的另一支 strict schema，在 `createVoiceOnboardingRoute` 里按 `v` 分流。缺 `v` 或 `v:1` 走现有 `store.step`。

v2 脑端动作只有：`begin`、`answer`、`skip`、`close`。

- `answer` 带 `question_index`、`question_revision`、`field`、`text`（最长仍 120）。
- `skip` 带 `question_index`、`question_revision`，不带 `text`。
- `close` 带 `reason=finish|cancel|expired`，不带 `text`。

工人到脑端的 HTTP 仍是 `POST /internal/voice-onboarding/step`，header 仍是 `x-p003-onboarding-grant` 和 `x-p003-worker-token`。`createVoiceOnboardingRoute` 的 JWT 角色、`VOICE_ONBOARDING_WORKER_ACCOUNTS`、413 和 403 保持。

存储：不建新表。在 `VoiceOnboardingStore` 构造函数里按现有 `age_years` 的方式，幂等增加一列可空 `question_state TEXT`。v1 的 `step` 不读不写该列。v2 用它保存：

```json
{"index":1,"revision":2,"phase":"window","audio_request_id":"...","write":"open"}
```

`phase` 为 `announced`、`window`、`closed`。`write` 为 `open` 或 `committed`。不要把题态塞进现有 `snapshot`。`snapshot` 今天要和绑定快照做整串比较，混进去会让正常答题变成 `stale_snapshot`。

字段映射写死，不接受客户端改字段名：1=`age`，2=`gender`，3=`nickname`。题序只允许 1 然后 2 然后 3。跳题是对当前题发 `question_skipped`，不是把 index 从 1 跳到 3。错序、重复的新 `request_id`、越界 index 都丢弃，不写库，也不因此结束整课。

## 7. 明确不做

- 不改 `buildOnboardingGuide` 的文案。普通聊天缺昵称、性别、年龄时的日常补问保留。教学隔离期间 `start_turn` 直接返回，引导词不会在三问里执行。
- 不增加逐句 LLM、搜索或额外 TTS。判定仍只用 `extractAnswer`。
- 不实现 GM 模拟协议。附件规定模拟不发真实控制、不写云端。服务端看到的任何教学写入都必须来自真实 grant 路径。
- 不删除画像、不解绑、不清设备。GM 清游戏档与服务端无关。
