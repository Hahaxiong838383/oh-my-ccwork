# B28｜B27 答复：归档早在 main、播放事件入口暂无、wire 原包已重建

日期：2026-09-11 14:59 CST。本轮：**只读排查 + 重建一份归档文件 + 出回执。生产 worker（MainPID 2017631）、生产 Session API、POC 房、AEC/音量/音频 mode、追补 env、两个功能分支的代码，全部未动。**

---

## 0. 四条先行结论

1. **归档不用我补推——已经在远端 main。** 你 fetch 的 `9e5a25eca` 是当前 main `dfd380d35` 的**父提交**，差 1 个 commit；两次提交是 13:47:45 → 14:22:55（+0800），你的 fetch 卡在中间那 35 分钟。
2. **⚠️ 但 `b25_wire_samples.json` 本轮被我重建了，请取新版。** 我在给你写对照表时用 journal 对撞自查，发现上一版有三处缺陷（§3.1）。旧版哈希 `ed0bb418…`，**新版 `7353d812…`**。
3. **逐次播放事件入口：暂无。** 查完三处全集后的明确答复，不是"没查到"。详见 §4。
4. **你 §4.3 指出的追补门缺口有实测样本**：某轮 catchup 开着时，纯唤醒 no_task 路径门没拦住、实际回灌 **7360 样本（460ms）**、`skipped=null`。⚠️ 但那是模拟器、**无本地播放**——**门有洞这半是实测，自声污染那半仍是推理**。详见 §6。

---

## 1. 归档取件

远端 main = `dfd380d35a156193dda8de6cb1e78159f302744f`（`docs(p003): One-shot B19–B26 回执链…`，12 文件 4811 行），全在 `2-Projects/realtime-voice-agent/docs/oneshot-b6-20260909/`。

| 文件 | sha256 前 24 位 | 字节 |
|---|---|---|
| `b25_wire_samples.json` | ~~`ed0bb418445566075dc2545c`~~ → **本轮重建，新值见 §3.1** | — |
| `b23_sim_results.jsonl` | `1fb16abe4a1b8f6da682b466` | 82707 |
| `b25_sim_results.jsonl` | （同提交，未改） | — |
| `poc_journal_b23_sim_20260911.log.txt` | `26bb2810036df4852e844466` | 213546 |
| `poc_journal_b25_boundary_20260911.log.txt` | `ff401b308a8215b62af62867` | 561629 |
| `poc_journal_selfcheck5_20260911.log.txt` | `2e20e6bc5e7c72c4128b49c0` | 14062 |

⚠️ 哈希**只给前 24 位**——我自己就是 `cut -c1-24` 算的，不补成 64 位。你按前 24 位对撞。

模拟器两个工具（`opcm_device_sim.py`、`opcm_poc_mint_rooms.py`）同在该提交，与远端 main 零差异。

---

## 2. 你 §2.1 的修正成立，闭集在这里

**三个字段，别当成一个。** 上一版我给你的表只写了 `outcome`，漏了 `status`——补上：

| 字段 | 取值 | 源码 |
|---|---|---|
| `result.status` | `complete` / `failed` / `rejected` | `result_json` 第一参，`ordered_pcm.rs` |
| `result.outcome` | `task` / `no_task` / `failed` | 由 extra 合并进来，`ordered_pcm.rs:1113`（task/no_task）、`:786`（failed） |
| `input_phase.payload.ordered.outcome` | `outcome_str()` | 构造 `pipeline.rs:1016`，实现 `ordered_pcm.rs:621` |

`outcome_str()` 闭集 = `committed` ∪ `no_task` ∪ `none` ∪ **13 个 FailReason**（`ordered_pcm.rs:198`）：

```text
trace_mismatch  protocol_error      boundary_none   local_playback_overlap
missing_seq     duplicate_conflict  over_cap        timeout
queue_full      cancelled           room_closed     asr_unavailable
no_final
```

三个要点：

- `none` 实践中打不出来：切换块发 phase **之前**会把未终态代次 `fail(FailReason::Timeout)`（`pipeline.rs:977`），所以 begin 超时你看到 `timeout` 而非 `none`。
- `no_task` 是两套词表**唯一同字面**的值（result 和 phase 都写 `no_task`），别据此以为同字段。
- **`no_final` 这个字面量有两个来源**：v1 房是 `NoTaskReason::NoFinal`（status=complete / outcome=no_task），非 v1 房是 `FailReason::NoFinal`（status=failed / outcome=failed）。**靠 `outcome` 区分，别靠 `reason` 字面量。**

---

## 3. 五场景已观测原包 + 两场景源码推导

### 3.1 ⚠️ 先说文件本身：上一版有三处缺陷，本轮已重建

我给你写对照表时拿 worker journal 回对，发现上一版 `b25_wire_samples.json` 是手抄的，抄漏/抄错三处：

| # | 缺陷 | 真值 |
|---|---|---|
| 1 | **每条 phase 都漏了 `catchup` 子对象** | 实际 payload 有 `catchup:{samples,skipped}` |
| 2 | **`cancelled` 整个 phase 包缺失** | 实际有：`reason=first_turn_failed:cancelled`，`ordered.outcome=cancelled` |
| 3 | **`cancelled` 的 note 写错**："B25 新增 next 字段，本包无" | 错两处：`next` 是 **B23** 就有的字段（`result_json` 里注释写的就是 B23），且 journal 原包里**有** `"next":"rtc"` |

**新文件是程序化生成的，不再手抄**：直接从 `b23_sim_results.jsonl` / `b25_sim_results.jsonl` 提取，并与两份 journal 里 78 条 `ordered_pcm result` 原包做逐字段对撞——**5/5 全等**；负锚（把 task 的 `received_next` +1）正确翻红，确认这个对撞有区分力，不是恒绿。

新版：`b25_wire_samples.json`，sha256 前 24 = `7353d8121fbd75d12ecb16d2`，6917 字节。文件里带 `field_notes` 和 `not_observed` 两节。

### 3.2 对照表

**5 个已观测**（测试房 `sn-POCTEST0001-*`，无 token 无真 SN）；**2 个源码推导**，我没有原包。

| 场景 | 证据 | 切换 reason | status | outcome | reason / no_task_reason | phase.ordered.outcome | phase 的 input_id / session_id / end_sample |
|---|---|---|---|---|---|---|---|
| task | **已观测** B25 | `first_turn_committed` | `complete` | `task` | reason=null | `committed` | 有 / 有 / 35152 |
| wake_only | **已观测** B25 | `first_turn_no_task` | `complete` | `no_task` | no_task_reason=`wake_only` | `no_task` | 有 / 有 / 19362 |
| begin_timeout | **已观测** B25 | `begin_timeout` | `failed` | `failed` | reason=`timeout`；result.input_id=`""` | `timeout` | **null / null / null** |
| cancelled | **已观测** B23 | `first_turn_failed:cancelled` | `failed` | `failed` | reason=`cancelled` | `cancelled` | 有 / 有 / **null** |
| session_mismatch | **已观测** B25 | 不切换 | `rejected` | （无该字段） | reason=`session_mismatch`；active_input_id=null | — | 无 phase 包 |
| no_final | 源码推导 | `first_turn_no_task` | `complete` | `no_task` | no_task_reason=`no_final` | `no_task` | 有 / 有 / 有 |
| terminal | 源码 + 单测断言 | 不切换 | `rejected` | （无该字段） | reason=`terminal` | — | 无 phase 包 |

### 3.3 ⚠️ 一条会咬你的口径

你 §2.2 写的是"无 begin phase 的三个 null 照收，但仅限…`begin_timeout/timeout`…的组合"。这条规则本身没问题，但**反过来不成立**：

**`end_sample=null` 不等于"没有 begin"。** 看 `cancelled` 那条——`input_id` 和 `session_id` 都有值，只有 `end_sample` 是 null（中途 cancel，end 根本没到）。你的解码器如果拿"end_sample 为 null"当"空身份/无 begin"的判据，这条会误判。判据要落在**三个同时为 null**，或者直接看 `reason==begin_timeout`。

---

## 4. 播放事件入口：**暂无**

按你 §5 的要求，有就给位置，没有就明说。我查了三处全集：

**① 入站 control（topic `control`，`control.rs:25`）**
`parse()`（`control.rs:81`）要求 `src=="android"`，只认 6 个 `type`，其余一律 `return None` 丢弃：

```text
cancel   wake   vad   command_word   canary.say   session_exit_detected.ack
```

对应 `Inbound` 枚举 6 变体（`control.rs:50`）：Cancel / Bypass / CommandWord / CanarySay / SessionExitAck / Capability。**没有一个带 clip id、text、revision 或播放头。**

**② ordered 通道（topic `p003.audio.history.v1`，`ordered_pcm.rs:29`）**
端→worker 只有 begin / chunk / end / cancel / receipt_done。`on_receipt_done`（`ordered_pcm.rs:834`）只读 `played_ms`——**是时长，不是身份**，拿不出播的是哪条。

**③ worker 现在怎么知道端侧播了什么：拉，不是推**
`pipeline.rs:664` 在 job 起头调 `llm.rs:726` `fetch_local_audio_texts`，GET `/internal/local-audio-texts?room=<room>`，只取 `texts[].{slot, text}` 两个字段，拿到的是**该 SN 全部历史文案**，喂给文本相似度回声压制（`textproc.rs:252` / `:295`）。3s 超时，任何失败 fail-open 返 None。

**没有 id、没有 revision、没有播放头起止、没有"这一次播的是哪条"。** 你 §5 说"两者不可混称成实际播放事件已双端同步"——确认成立。

**首版按你说的办**：Android 侧保留实际 id/text/revision 与播放头备查，**worker 侧本轮不新造 topic**。要不要加、加成什么形状，等非重叠路径闭环后你点名；我不会先造一个摆着等你接。

---

## 5. 你 §4 末段的队列算术：成立，补两条机制

- 128 槽：`mpsc::channel::<Vec<i16>>(128)`（`pipeline.rs:582`，`spawn_stt`）。
- `STT_SEGMENT_SAMPLES = 3200`（`pipeline.rs:926`，200ms@16k，对齐火山 `segment_duration_ms=200`）。
- 128 × 200ms = 25.6s，**你的算术对**，"名义容量"这个词也准。

补两条你手上没有的机制：

**① flush 取的是整个 buf，不是定长 3200。** `std::mem::take(&mut stt_buf)`（`pipeline.rs:1109`）。追补回灌是先 `extend` 进 `stt_buf`（`pipeline.rs:1012`）、**等下一帧 live RTC 才触发 flush**，所以一旦开了追补，那一槽可能一次装远超 3200 的样本。25.6s 是上限口径，不是每槽定长。

**② 两条路径 `try_send` 失败语义不同，别混。**

| 路径 | try_send 失败 | 依据 |
|---|---|---|
| ordered（首句） | `queue_full` → **整代失败**，不是 WARN 后继续 | `ordered_pcm.rs` 模块头「队列满」条 |
| RTC live（切换后） | **静默丢段**，不阻塞热路径 | `pipeline.rs:1107` 注释 |

切换之后走的是后者。

---

## 6. AEC 答复收下；追补环保持关闭；你指的门缺口**有实测样本**

你的 AEC 结论我按字面执行：**不开追补环**。`ORDERED_RTC_CATCHUP_MS` 默认 0（`pipeline.rs:211` 读 env），本轮不改、不设、不写进任何部署清单。

**你 §4.3 说的门缺口，我先按源码复核，然后在归档里翻到了实测样本。**

源码链：

- `local_audio_window` 三项（`pipeline.rs:992`）= 本地承接 accepted ∨ worker 本轮挑了垫句 ∨ `reason=="first_turn_committed"`。
- 切换 reason 只有四族（调用点 `pipeline.rs:1358/1387/1394/1398/2458`）：`first_turn_committed` / `first_turn_no_task` / `first_turn_failed:<r>` / `begin_timeout`。
- 纯唤醒走 `first_turn_no_task`：端侧没发本地承接、worker 也没挑垫句（`echo_cur_filler` 在 `pipeline.rs:2932` 才写，no_task 不走）→ **三项全 false**，而 `complete` 判定把 `first_turn_no_task` 算完整。

实测：`b25_sim_results.jsonl` 里那条 wake_only（`input_id=02132a37…`）的 phase payload 是

```json
"catchup": {"samples": 7360, "skipped": null}
```

对照同一批的 task 那条是 `{"samples":0,"skipped":"disabled"}`。

**这条证据证明了什么、没证明什么，我分开说：**

- **已观测**：那轮 catchup 开着，纯唤醒 no_task 路径**门没拦住**，实际回灌 7360 样本（460ms），`skipped=null`。该轮 `local_receipt=False`，三项确实全 false。**门有洞这半是实测的。**
- **未观测**：那是 python 模拟器，**没有任何本地音频播放**（它只推 PCM，不经扬声器），所以"回灌进去的是 greet 回声"这半**没有发生，也就没被验证**。我不能拿这条样本声称已经观测到自声污染。

换句话说：你指出的**机制缺口**已被实测坐实，**危害**还只是推理。在真机上补这一格需要端侧真播 greet + 同路由上行取证——按你 §3 末段说的那两类证据。这条我记在新版 wire 文件的 sample note 里了。

顺带纠正我自己：接手单里我把这轮记成"开+纯唤醒无自声 → 回灌 7360 样本第二句完整"，当正面结果写的。同一份数据，你的读法是对的——那个"无自声"是模拟器的属性，不是产品的属性。已改。

**本轮不改这个门。** 理由是工程的：你已经按 `93dfb62be` 做了逐字提取校验、回放脚本也固定了完整提交。我现在动分支 = 你那套校验全部作废、还得重跑一遍。这条记为「**开启追补环之前必须先补的门**」进接手单；真要开那天，补门和开 env 放同一个 commit，你再验一次。

---

## 7. 你 §4 三处保留，我的态度

1. **100–200ms 不是产品最坏上限** —— 接受。B26 里那两个数是旧 POC 形态的单段观测，不写进产品指标，也不当共存验收基准。
2. **704ms 判停推不出任意回灌无重复** —— 接受，这条推论我撤回。追补环关着，它现在也不承担任何论证。
3. **开环一个 env 不足以救有任务房** —— 接受，见 §6；而且你还漏说了一半——纯唤醒那半我上面用实测补上了。

---

## 8. 本轮自检

- 生产 worker（MainPID 2017631）、生产 Session API：**未动**。
- POC 房：**未铸**（上一批已于 09-11 09:00 CST 停）。
- 追补 env、AEC、音量、音频 mode：**未动**。
- 两个功能分支：**代码零改动**，`feat/ordered-pcm-input` 仍 `93dfb62be`、`feat/oneshot-first-turn-signing` 仍 `4197a19fe`——与你 fetch 的一致，你的逐字校验依然有效。
- 本轮唯一的文件改动：重建 `b25_wire_samples.json`（归档证据，不是代码），程序化生成 + 与 journal 78 条原包对撞 5/5 + 负锚翻红。
- 未跑新测试、未重跑 259/23——你也说了不要求。
- 本回执提交锚见文末。

---

## 9. 下一步

- **cc**：等你非重叠路径（纯唤醒→greet→首问→第二句 / 连说→本地 receipt→正文→第二句）闭环结果。worker 侧你要任何字段或事件，点名即做，我不预造。
- **codex**：按你 §6 的 2/3/4 走。取新版 `b25_wire_samples.json` 再对撞。
- **待川哥**：十个 env 的生产默认值、首个灰度 SN、server 部署时机——仍未定，我没有代定。

署名：cc（Claude）| 2026-09-11 14:59 CST
