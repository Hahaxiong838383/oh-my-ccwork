# 语音教学 v2 独立验收

结论：**候选 `40233116448c23922f08b702728c2afbb7f029f2` 代码阶段不收口。** 有 1 条阻断。Brain/Worker 教学模块的合同行为有本次实测；ordered 首句房间的 v2 `begin` 不会放开 RTC，fresh VAD 进不了教学答案。

基线 `81cbd0b10be15037f8f3fe0ea4846eb6bac6236b`。未改共享树，未 SSH，未部署，未发消息。验收期间共享树 HEAD 已离开候选，到了 `da3109f7385d56d5b2829959ef4f54aa5b9a8b19`，并出现未提交文档和测试。那些改动不计入本 SHA。`da3109f` 给 pipeline 加了 phase switch，也不算候选已通过。

## 阻断

协商了 ordered 首句、`input_phase == FirstTurn` 时，音频循环在 VAD 和 `speech()` 之前丢弃 RTC 帧（候选 `pipeline.rs` 1294–1314，`ordered_first_turn_active` 1523–1525）。v1 的 `begin` 会在这道门开着时进入 9 秒 deferred。v2 故意不进 deferred，`begin` 后立刻 `control()`、`hard_abort_current()`、清投机和 turn gate（2442–2454），但**不**调用 `request_phase_switch`。

因此教学隔离已经开始，孩子的 RTC 仍进不了 fresh VAD / ASR。自动放开只发生在 ordered 代次自己结束，或 phase 仍是 Idle 且 `input_loop` 已超过 `ORDERED_BEGIN_TIMEOUT_MS`（默认 2500ms）时的 `begin_timeout`（3179–3186）。代次已经不是 Idle 时，这个超时不会开火。

入口测试包不编译 `pipeline.rs`，所以下面的 47/47 覆盖不到这条路径。证据是候选 blob 的源码路径，不是 root 报告。

普通房间（没有 ordered，或已经离开 FirstTurn）不受这条阻断影响。`begin` 对普通 LLM / TTS / 搜索的阻断在源码上是另一条路：`on_final` 在 v2 `active()` 时调用 `answer()` 后 return；`start_turn` / `start_speculation` 看到 `active()` 直接返回。这条 LLM 门没有执行级测试。

## 已测通过

口径按候选 `CONTRACT.md`，不按先前 review 里被否决的覆盖规则。已有孩子或家长字段保持原值，回执是 `accepted` + `skipped`。家长行只读。这不是缺陷。

Node 28/28，从候选 `git archive` 跑，不用工作树上改过的 v2 测试。包含：

- v2 固定 1/2/3，服务端不选题、不带 cue；识别与 `memory_write` 分开；重放幂等，改字节 409。
- 已知资料不覆盖。年龄不写生日。静默、拒绝、听不清不编造资料，旧答案不能再写入。
- SQLite 触发器失败是 `accepted` + `failed`，下一题仍可 `saved`。
- 伪造 worker、simulation、旧 trace / 旧 lesson、错 revision、重复不同 request、重绑定、180 秒过期拒绝写入。
- `cancel` 先于 `begin` 封闭，迟到 `begin` 410。
- 版本门默认关。只声明 v2 且未开 `VOICE_ONBOARDING_V2_ENABLED` 时没有合同。门打开后响应和 metadata 都是 version 2。v1 会话测试仍签 version 1。
- 既有 v1：不覆盖已知字段、家长字段跳过、非姓名不落库、拒绝立即关写授权、TTL 不续期。

另一次候选库探测：家长行已有昵称、性别、生日时，三题都是 `accepted` + `skipped`，家长行和孩子行逐列不变。退出码 0。见 `logs/parent-skip-probe.log`。

Rust 入口 47/47。私有 `CARGO_TARGET_DIR`，离线 `--locked`，cargo 1.100.0，不用 brew cargo。编译前核对 `voice_onboarding.rs`、`voice_onboarding_v2.rs`、`voice_onboarding_tests.rs` 的 git blob 与候选一致。`control.rs` 相对候选无差异，所以 47 里含它的 24 个测试。通过项包括：

- 三题顺序；播完前的答案丢弃；`answer_result.request_id` 等于打开该窗的 `audio_complete`（测试里的 `v2-5`）。
- 重复 `audio_complete` 保留 fresh VAD；新题清掉上一题 VAD；播音期间退出词当回声丢掉，窗内新 VAD 的退出词仍走 Exit。
- 跳题后迟到 `accepted/saved` 不重开题、不发 Brain 写入。真实 HTTP→SQLite：在途「八岁」被 skip 撤掉后 `age_years` 仍为空，第 2 题性别写入，第 3 题昵称写入，finish 后不再 active。
- 单题 failed / declined / unrecognized 保持隔离，下一题仍可开始。
- `now == begin + 180000` 的 `finish` 结果是 `expired`，不是 `finished`。只 tick 到期时仍 `active()` 且挡输入，deadline 变空，不第二次终态。
- simulation、错身份、错 trace、跳号题序、`audio_status=failed` 关窗不结束课。
- v1：重复 audio 收据保留 fresh speech；cancel/finish 封住迟到 begin。

控制队列在 Runtime 里串行，音频循环不 await HTTP。真实 HTTP 测试在本地控制之间故意不等待。入口包没有把 `pipeline.rs` 链进去，音频循环本身没有被这个二进制执行。

## 未验

- 新 Android 包没编，没有上机。
- 没有 RTC、供应商 ASR、AEC 的真人验收。
- 现有 ASR 只有 `Final(String)`。fresh VAD 加题类型门禁不能当成所有跨题声学迟到已经证实。
- 服务端不能证明 4A/4B 真的播过。`finish` 只表示端侧声称隔离可结束。
- 全仓 `tsc` 本次没跑。候选相对基线的 diff 不含 `listening-content.ts`。
- `Orchestrator` 没在测试进程里跑。上面的阻断因此不是一颗失败的测试，而是候选 pipeline 的可达路径。

代码阶段和真机阶段分开。本次即使补上 phase switch，也不能宣布真机通过。

## 命令和结果

Node：

```
PATH=/Users/fu-121/.local/node-v24/bin:$PATH
# 源码来自 git archive 40233116448c23922f08b702728c2afbb7f029f2
node --import tsx --test \
  scripts/voice-onboarding.test.ts \
  scripts/voice-onboarding-session.test.ts \
  scripts/voice-onboarding-memory.test.ts \
  scripts/voice-onboarding-v2.test.ts
```

结果：`tests 28 / pass 28 / fail 0`，19.8s，退出码 0。Node v24.19.0。日志 `logs/node-tests.log`。

Rust：

```
CARGO_HOME=$W/.voice-onboarding-build/cargo
RUSTUP_HOME=$W/.voice-onboarding-build/rustup
PATH=/Users/fu-121/.local/node-v24/bin:$CARGO_HOME/bin:$PATH
CARGO_TARGET_DIR=/Users/fu-121/.local/state/p003-onboarding-v2-20261117/grok-final-review/entry-target
CARGO_NET_OFFLINE=true
cargo test --offline --locked -- --test-threads=8
```

目录：`rust-worker/tools/onboarding-entry-tests`。结果：`47 passed; 0 failed`，2.36s，退出码 0。doc-tests 0。日志 `logs/rust-entry-tests.log`。没有现成且能对上候选生产模块的可执行测试二进制，所以是这次私有目录重新编译，没有占用共享 worker target。

候选文件 SHA-256：

| 文件 | SHA-256 |
|---|---|
| `rust-worker/src/voice_onboarding.rs` | `c1a42c0a7539877d4f8fca1c842e792832862aef1a4eb638d32428f654444266` |
| `rust-worker/src/voice_onboarding_v2.rs` | `cb431f1053b95a106f601ef5c07c1936b24764e6118b2558076609ed52d68420` |
| `rust-worker/src/pipeline.rs` | `a52725ce4dcb29adbe54c1e21654d17cfb37665c300cf3537efff2e4ba5a7208` |
| `apps/server/src/voice-onboarding-store.ts` | `93a8d064acd8f0b20ba43c4a4fd4bd3425bc4e60d1a51188c8feb5eade6a578f` |
