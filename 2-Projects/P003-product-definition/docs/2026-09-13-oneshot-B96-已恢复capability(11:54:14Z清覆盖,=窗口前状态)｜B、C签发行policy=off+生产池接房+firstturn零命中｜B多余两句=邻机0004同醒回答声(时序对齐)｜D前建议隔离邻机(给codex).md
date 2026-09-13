# B96｜已恢复 `capability`（2026-09-13T11:54:14Z / 19:54:14 CST）；B/C 服务端半边对齐；B 的两条额外输入有了时序定位

**结论：生产 One-shot 策略已恢复——用「清除后台覆盖」回落 env，effective `capability` / source `env` / override `null`，与窗口前状态逐字段相同（`runtime_flag` 0 行），这样 D 的签发行与 A 只差时间一个变量。B/C 两条 trace 的服务端签发行和生产池接房证据齐了，firstturn 池零命中、零 ordered begin。B 房多出的两句在 worker 侧是「钱这个算标准吗」「要不要再来一张」（各 7 字，对上你的 `chars=7`），时序上落在邻机 ***0004 播放自己回答的窗口内、且晚于 0010 自己的回答播完——最像邻机回答声，不是 0010 的回声/AEC；正文级不可核（worker 不记回复文本）。codex 可以直接做 D；建议 D 前把 0003/0004 静音或挪出耳距。**

## 1. 恢复事实（B95 §4.1）

| 项 | 值 |
|---|---|
| 生效时刻 | `2026-09-13T11:54:14Z`（19:54:14 CST）；`[admin-oneshot] override cleared removed=true off(override) → capability(env)` |
| 之前 | effective `off` / source `override`（B94 那行，`updated_at 1789295139027`） |
| 之后（GET 复核） | effective **`capability`** / source **`env`** / env `capability` / override **`null`** |
| 为什么用清除而不是 PUT capability | 回到窗口前的同一状态（无覆盖行），D 与 A 的 `policy=capability policy_src=env` 完全同形；PUT 会留一行 `policy_src=override`，多一个变量 |
| off 实际持续 | 10:25:38Z → 11:54:14Z ≈ 89 min（转发链路延迟；期间除 0010 只有 0003/0004 老端签发，见 §3） |
| 未动 | 两池 MainPID（firstturn 2902239 / rust 2720004）、env、程序、APK 均未动；无重启 |

## 2. B/C 服务端半边（B95 §4.2）

| 用例 | trace | 签发行（脱敏） | 生产池 `voice-worker-rust` | firstturn 池 |
|---|---|---|---|---|
| B 传统 | `6e1f0a13-5582-47a3-ab8b-0ffb80fd8b53` | `sn=***0010 room=sn-***0010-1789295691 contract=- policy=off policy_src=override supports=oneshot_first_turn_v1\|local_receipt_v1 ttl=3600s` | 10:34:52.098Z accepting → 10:34:56.477Z `turn committed: 3+5等于几`（eou 754/stt 711）→ 回答播完 10:35:02.135Z → …（§4）→ 10:35:23.88Z control cancel → 10:35:24.09Z job closed uptime 31s | **0 行** |
| C 连说 | `39c96897-9255-4818-a3bf-f94b1ef145d5` | 同上 + `prefetch=e4e23f30…`（预取票据也走了 null 合同） | 10:35:58.128Z accepting → 10:36:02.375Z `turn committed: 3+5等于几`（eou 764/stt 731）→ 10:36:13.545Z job closed uptime 15s | **0 行** |

两房在生产池 journal 里 **没有任何 `ordered_pcm` 行**（零 ordered begin/chunk/receipt 投旧 Worker，与你 `first_turn_begin=0` 互证）。`supports=oneshot_first_turn_v1|local_receipt_v1` 但 `contract=-`：新端照常上报能力、服务端按 off 不签——这就是与老端 `supports=-` 的区分点，D 时应变回 `contract=first_turn_v1 policy=capability policy_src=env`。

## 3. 窗口期全部签发（影响面事后核）

| 房 epoch | SN 尾 | contract | policy / src | supports |
|---|---|---|---|---|
| 1789295691 | ***0010（B） | - | off / override | 双 supports |
| 1789295692 | ***0004 | - | off / override | - |
| 1789295693 | ***0003 | - | off / override | - |
| 1789295757 | ***0003 | - | off / override | - |
| 1789295758 | ***0010（C） | - | off / override | 双 supports |

窗口内没有 0010 之外的带 supports 设备，没有签发失败行（只有 prefetch 行）。**注意 0003/0004 每次都在 0010 唤醒后 1–2 秒签发**（A1 时也是：0010 …3713 → 0004 …3714 → 0003 …3715）：它们与 0010 同处一个声场，被 Air 扬声器的「小可小可」一起叫醒。

## 4. B 的两条额外输入：worker 侧定位（B95 §3、§4.3）

0010 B 房（生产池）完整轮次：

| 时刻（worker 钟，UTC） | 事件 |
|---|---|
| 10:34:56.477 | turn 1 committed `3+5等于几` → filler「我想想哈。」→ 回答 |
| 10:35:02.135 | turn 1 播完（speaking→listening）——**0010 自己的声音到此结束** |
| 10:35:05.877 | turn 2 committed **`钱这个算标准吗`**（7 字，eou 428，stt_ms=0）→ filler「嗯……」 |
| 10:35:07.377 | turn 2 被打断（agent turn aborted，interim `要不要再来一张`）→ turn 3 committed **`要不要再来一张`**（7 字）→ barge filler「你说」→ 回答播到 10:35:18.695 |
| 10:35:23.88 / 24.09 | control cancel（seq 6）/ job closed |

与你端侧 18:35:03.852 / 05.363 CST 的两条 `chars=7` 一一对应（端钟比 worker 钟约慢 1.6–2.0 s，与 A/B 其它事件的偏移一致；顺序、字数、间隔都吻合）。

同一时刻邻机 ***0004 房（1789295692）：10:34:56.570 committed `3+5等于几` → 10:34:58.870 **`echo suppressed: '这个' ⊂ recent tts`**（它自己的回复正文含「这个」）→ 播放持续到 10:35:09.311（speaking→listening）。***0003 房 1789295693 只活了 6 s（10:34:59.44 关房），没有 commit。

推断（标「推断」，正文级证据缺）：两句额外输入 = **0004 通过自己的扬声器播放回答，被 0010 的麦收到**。依据：① 时间完全落在 0004 播放窗口内（10:34:58–10:35:09）且晚于 0010 自己播完（10:35:02）→ 不是 0010 的回声、不是 AEC 问题；② 「钱这个算标准吗」含「这个」，0004 的回复正文恰好含「这个」；③ 「要不要再来一张」与小可常见追问「要不要再来一题」同形（张/题 误识）；④ 0003 无输出、Air 只播脚本句、C 轮 0003 的回答没被 0010 听到（可能距离/音量不同）。不能排除的是现场真人说话——worker 按设计不记回复正文，我拿不到 0004 的原句。

**零成本判定（建议放进 D）**：D 前把 0003/0004 静音/挪出耳距（或拔电）；D 房若不再出现非脚本 final，即坐实；同时 D 的 One-shot 首句也不会被邻机回答声污染判停。这条不改代码、不动 AEC、不录音，符合你的边界。

## 5. 结论口径（B95 §4.4）
- v272 在 off 下「不失声、可明确重说、同次唤醒、零 ordered 投旧池」四条服务端半边全部对上；**v272 起 `off` 可作新版可用的普通回退**（RELEASES 与 skill 口径本轮改）；v271 原包仍是止扩口径，不追溯。
- 「恢复后自动 One-shot」等 D：预期签发行 `contract=first_turn_v1 policy=capability policy_src=env`，firstturn 池 `ordered_pcm begin accepted`，生产池零命中。D 做完给 trace，我补这三条。
- 邻机同醒是测试现场现象，也是一个真实产品场景（一屋多台设备）——记为观察，不在本窗口展开。

署名：cc（Claude）| 2026-09-13 19:57 CST
