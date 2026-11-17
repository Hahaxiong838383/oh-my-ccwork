# 退出增量审查 42df1d0

没有代码阻断。本审查只覆盖 `42df1d0320aec5338c9d1be2c11de6e514966944` 相对 `da3109f7385d56d5b2829959ef4f54aa5b9a8b19` 的 3 个文件，以及相邻的 pipeline 退出分支；402 主体与 ordered 切 RTC 不在本次结论内。共享工作树未被本审查修改。

## 范围

- 父提交就是 `da3109f7385d56d5b2829959ef4f54aa5b9a8b19`。`git diff --shortstat` 为 3 files changed, 16 insertions(+), 2 deletions(-)。
- 文件：`voice_onboarding.rs`、`voice_onboarding_v2.rs`、`voice_onboarding_tests.rs`。
- 工作树这三份源与该提交 blob 逐字节相同。未重编依赖，未跑根上 47 项，未把 `worker-final-exit-pending.txt` 当作本审查的通过证据。

| 文件 | sha256 |
| --- | --- |
| `rust-worker/src/voice_onboarding.rs` | `7caaec83888f45c75659315af59243fe1badb8bed4aa78f73be35e747af0c8d4` |
| `rust-worker/src/voice_onboarding_tests.rs` | `b4a6f3d1527ac74a5d9f73c2ab33397d7b37094a81a99262b8244c54234898a9` |
| `rust-worker/src/voice_onboarding_v2.rs` | `4f9396b1db4a386bb5c5dfef59c9d987bde571ad39a2426d66d7a1d0a2e95bac` |

## 三处逻辑

`Session::blocks_input` 的 v2 分支现在只在课时仍活跃且 `phase != "ready"` 时阻断（`voice_onboarding.rs:97-100`）。`pending` 不再进入这个判断。v1 分支仍是 `active && (pending || stage 以 speaking 结尾)`（同文件 102-107 行），差分没有改它。

因此 phase 为 `speaking`、`skipped`、`expired`、`answered`、`idle` 时仍然阻断；`ready` 且保存请求未回时不再阻断。这些 phase 赋值在 `voice_onboarding_v2.rs:116-123`、`145`、`195`、`230`。

`answer_v2` 在 `blocks_input()` 之外单独拒绝 `self.pending`（`voice_onboarding_v2.rs:176-177`）。ready 且 pending 时，第二段答案返回空效果，不会再排一次 `answer` 写。

`Runtime::input_route` 在 v2 活跃且（`blocks_input` 或还没有 fresh speech）时直接 Drop（`voice_onboarding.rs:463-466`）。`speech` 只在未阻断时记下 fresh speech（473-476 行）。`poll` 只在 `blocks_input` 时清 `speech_seen`（618-620 行）。pending 不再让这三处把「退下」清掉。

## 相邻 pipeline 退出分支

入口二进制不编译 `pipeline.rs`。下面是对当前源的只读核对，行号属于未改的相邻代码。

- `pipeline.rs:1334-1336`：`blocks_input` 为真才清空 VAD 并跳过 `speech()`。ready 且 pending 时会执行 `speech()`，fresh VAD 能记上。
- `pipeline.rs:2034-2041`：final 先走 `input_route`。Exit 调用 `begin_session_exit` 后返回，不会再把这句话交给 `answer()`。
- `pipeline.rs:3134-3135`：`begin_session_exit` 调用 `Runtime::cancel`。v2 `close_v2` 把课时终结；`apply` 对 `cancel` 清空队列并 abort 在飞 HTTP（`voice_onboarding.rs:535-540`）。退出命中后，这次 pending 的答案写不会继续落地。
- `pipeline.rs:2047-2050`：非退出 final 在 v2 活跃时只 `answer()` 然后返回。pending 时 `answer_v2` 不入队。
- `pipeline.rs:1876`：onboarding 活跃时不起普通投机。打开 pending 期间的 VAD 不会从这里进入普通 LLM。
- `pipeline.rs:2023` 与 `2047-2050`：v2 活跃时 interim 和 final 都不进 `turn_gate`。`3218` 的 commit 路径不是这条 v2 退出路径。`3398` 的 `waiting_exit` 只看 v1 `stage`。

`pipeline.rs:1294` 的 ordered 首句丢 RTC 帧属于 da3109，本次不重复判定。本增量的 fresh VAD 只有在该 `continue` 未拿走帧时才会走到 `1334`。

## 实测

二进制：`.voice-onboarding-build/entry-cargo/debug/build/onboarding-entry-tests/d9e05ea1bb3770ad/out/onboarding_entry_tests-d9e05ea1bb3770ad`

二进制内含字符串 `network wait must not swallow a fresh exit command`、`pending answer must not enqueue a second write` 和测试名 `v2_runtime_duplicate_keeps_fresh_vad_and_no_echo_exit`。测试 URL 为 `http://127.0.0.1:1/v1`。

命令与退出码 0：

```text
onboarding_entry_tests-d9e05ea1bb3770ad v2_runtime_duplicate --test-threads=1
```

```text
running 1 test
test voice_onboarding::tests::v2_runtime_duplicate_keeps_fresh_vad_and_no_echo_exit ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 46 filtered out; finished in 0.01s
```

该测试在同一函数里覆盖：未 ready 时 exit 为 Drop；pending 期间 `speech` 后 `input_route(true) == Exit`；第二答案不增加队列；`question_skipped` 后 `speech_seen` 为假且队列里没有 answer。46 项被滤掉，不能当成 47/47。

## 未验的真人 ASR 边界

没有真人麦克风、厂商 ASR、AEC 或真机 RTC。未验证「退下」在端点检测前后的切句：若 HTTP 回复已经把 phase 写成 `answered`（`voice_onboarding_v2.rs:230`）之后 final 才到达，`answered` 仍按合同阻断输入。`Runtime::answer` 在空效果时也会清 `speech_seen`（`voice_onboarding.rs:584`）；同一次 fresh speech 里若先来一条非退出 final，再来退出 final，后一条会 Drop。单条已匹配退出词的 final 在 `pipeline.rs:2039` 返回，不会先走 `answer()`。

## 附：profile 探针错误聚合

`root-next-profile/profile-first-request.mjs` 相对 `grok-next-review/profile-first-request.mjs` 实际只多 2 行，不是 3 行：

```javascript
report.phase_errors=report.phases.filter(p=>p.error!==null).map(p=>({name:p.name,error:p.error}));
if(report.phase_errors.length)failed??='PROFILE_PHASE_FAILED';
```

位置是修复稿 253-254 行。`phase()`（87-93 行）把 SQL 异常收进 `phase.error` 且不向外抛，所以原先外层 `failed` 仍为 null，`ok` 为真，`process.exit` 为 0。这两行把 `error !== null` 的阶段抄出，并只在 `failed` 还空时写入 `PROFILE_PHASE_FAILED`。随后既有的 `report.ok=!failed&&!size` 与 `exit(size?3:failed?4:0)`（261-263 行）会变成 ok 假、退出码 4。它不覆盖更早的 `failed` 文案，也不抹掉各阶段自己的 `error`。

本会话用 Python `subprocess` 读完整 stdout，库是只含 `analytics_event(device_key)` 的临时库，`T5_PROFILE_ALLOW_SMALL=1`，无云端：

| 稿 | exit | ok | error | 带 error 的 phase | phase_errors |
| --- | --- | --- | --- | --- | --- |
| grok-next-review 原版 | 0 | true | null | 10 | 无此字段 |
| root-next-profile 修复稿 | 4 | false | PROFILE_PHASE_FAILED | 10 | 10 |

十项都是 `no such index: analytics_ark_device_event_received`。成功阶段的 `error` 初始为 null，干净路径不会被这道过滤改成失败。`profile-selftest.mjs` 本会话没有重跑；已有 `selftest-root.json` 为 status 0 且 `no_phase_error: true`。

`check-failed-phase.mjs` 在本机 Node v22.14.0 上因 `spawnSync` 只得到 8192 字节截断 JSON，`JSON.parse` 抛错，本审查不用它的退出码。磁盘上的 `failed-phase-red-green.json` 与上面这次完整 stdout 的 0 对 4 一致。
