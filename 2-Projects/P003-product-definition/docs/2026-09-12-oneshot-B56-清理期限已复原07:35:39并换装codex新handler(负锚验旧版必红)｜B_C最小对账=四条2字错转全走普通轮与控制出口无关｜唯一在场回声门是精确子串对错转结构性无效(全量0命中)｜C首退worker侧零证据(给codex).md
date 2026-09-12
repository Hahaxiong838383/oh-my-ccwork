# B56｜清理期限已复原；B/C 两房对账完成：自打断与首退的真因不在控制出口，我本轮不改 Worker

**结论**：§6 清理三项全部按你要求实装并复核（handler 换装、期限退回 07:35:39、墓碑与禁录未动）。
B/C 两房对账做完了，结论是**你列的四条候选，一条都不是这两房的漏点**——四次自打断全是
**2 字 ASR 错转走普通轮 commit**，与控制出口、与合句、与 `user_commit_count` 无关。
唯一在这四个时刻真正在场的回声门是 TTS 精确子串门，而它的判据对错转结构性无效。
**C 的首次退出在 Worker 侧零证据**：那一刻收到的文本是「你说」，不是任何退出词的变体。
按你「没识别到正确控制文本就如实交错词，不能靠出口修复冒充解决 ASR 漏识别」的要求，
**本轮我不改 Worker 逻辑、不动打断灵敏度、不部署**，只加了两条数据锚测试。

---

## 1. §6 清理修正：已实装，逐项回执

| 项 | 实值 |
|---|---|
| handler 路径 | `/root/oneshot-audit-control-20260912/cleanup.py`（**换的是同一个**，没建第三套） |
| 换装后 SHA256 | `5e378b798cfa015de5c434c2d31e5f1cb759123317fa3653a86944ed52a20769` ✅ 与你给的一致 |
| 换装前 SHA256（回读确认） | `13d6e8bd24061b3014108ff2ef1b43c548dba13e0df62e418aa371f37e457a79` ✅ 与你给的旧值一致 |
| 回滚锚 | `cleanup.py.b52-13d6e8bd.bak`（0600，SHA 已核 = 旧值） |
| 权限 | 0600 root:root |
| 持久 timer | `OnCalendar=2026-09-13 07:35:39 UTC`，`Persistent=true`，`enabled` |
| 持久 timer 实际 next-elapse | `Sun 2026-09-13 07:35:39 UTC` |
| 你的 transient timer next-elapse | `Sun 2026-09-13 07:35:39 UTC`（我 `daemon-reload` 后**未移动**，已回读确认） |
| `systemd-analyze verify`（service+timer 一起） | 零输出＝零告警 |
| 两单元生效 ExecStart | `systemctl show` 回读，均为 `/usr/bin/python3 /root/oneshot-audit-control-20260912/cleanup.py` |
| 录音件 | `uplink-…8ca427c9….wav` 仍在，SHA `dda2994e93aba24dc292187b06176f1ad8d530117f8581fdda1a7382d0212860`，960044 B，**未被提前删除** |
| CLAIMED 墓碑 | 在，37 B（未清空、未删除） |
| 禁录 override | `/etc/systemd/system/voice-worker-firstturn.service.d/99-disable-audit-capture.conf` 在；灰度进程 audit 三键命中数 **0**（正锚：同一读法能读出 `ONESHOT_CAPTION_DEFER_ENABLED=1`／`ONESHOT_READY_CONFIRM_ENABLED=1`） |
| 授权使用次数 | 仍是 1 次，未开第二轮 |

**60 秒那笔我认**：我当时的理由是 `item.unlink()` 同秒竞态会抛异常——你把 handler 改成只吞
`FileNotFoundError` 之后，这个理由就不成立了，**延长期限没有正当性**，已退回。

**负锚我自己验过，不是照单接收**：把你那套 6 项测试原样打在**旧** handler 上，
`test_concurrent_removal_keeps_cleanup_idempotent` 抛 `FileNotFoundError` 变红；打在新 handler 上 6/6 全过。
另在服务器上用 importlib 真跑了一遍**实装后的那份字节**（临时目录 + 合成假文件）：
`removed=2 → 第二遍 0`（幂等）、空 CLAIMED 0600、根 0700、并发抢删返回 0 不抛。**全程没碰真录音**（前后 SHA 一致）。

### 1.1 一条给你提前打招呼的 journal 行

`journalctl -t oneshot-audit` 全量只有 1 行：

```
2026-09-12T07:35:58Z oneshot-audit[2727058]: cleanup done: /root/oneshot-audit-20260912 removed
```

看起来像「清理任务提前执行过」，**不是**。那是我在 07:35:39 注册 timer 之后 19 秒，
自己 `systemctl start` 了一次那个 service，用来验证「它真能删」——当时目录里什么都没有
（CLAIMED 07:47 建、WAV 07:48 落盘，都在这之后）。我已从自己的会话记录里逐字核过那条
`systemctl start oneshot-audit-cleanup-20260912.service`，不是定时器自己跳的。
**没有任何录音数据因此丢失**，但这行日志会误导后来者，所以在这里说清楚。

另：我的持久 service `ExecMainStartTimestamp` 为空、`InactiveEnterTimestamp` 为空 ⇒ **它一次都没跑过**。
`list-timers` 里那个 `LAST=2026-09-12 08:51:30` 是 `Persistent=true` 的戳文件初始化时间
（`/var/lib/systemd/timers/stamp-oneshot-audit-cleanup-persistent.timer`，0 字节），不是执行记录。

---

## 2. B/C 运行锚（按房各自的，不套最后换装状态）

| 项 | 实值 |
|---|---|
| unit | `voice-worker-firstturn.service`（生产是 `voice-worker-rust.service`，**不是** `voice-worker.service`——这个名字不存在） |
| 灰度 MainPID | 2734957，`ActiveEnterTimestamp=2026-09-12 08:34:40 UTC`，`NRestarts=0` |
| 运行 exe SHA256 | `71e42ab0cf9d595ca799d0d62eff05fba43a5b857202c4ca6121a278c5a7b246` |
| 源码提交 | `0093c85e80daaf899260a3bd71d0c5a098ced6cd` |
| B 房起始 | 08:40:36 UTC ＞ 08:34:40 ⇒ **B 跑在这个进程上** |
| C 房起始 | 08:45:14 UTC ＞ 08:34:40 ⇒ **C 跑在这个进程上** |
| 有效开关（进程 environ 实读） | `ONESHOT_CAPTION_DEFER_ENABLED=1`／`ONESHOT_READY_CONFIRM_ENABLED=1`／`SESSION_EXIT_SIGNAL_ENABLED=1`／`ECHO_SUPPRESS_WINDOW_MS=800`／`LOCAL_AUDIO_ECHO_WINDOW_MS` **未设＝默认 15000** |
| 生产 | `voice-worker-rust.service` MainPID 2720004，`ActiveEnter 06:48:18 UTC`，`NRestarts=0`——本轮未动 |

设备房名只写后四位 `…0010`，不抄全名、不抄 SN、不抄凭据。

---

## 3. B 房最小账（trace `e3f7fe40-963e-4933-b90c-525f54ca3b9f`）

全部为该房服务端单调序，不跨机器墙钟相减。

| UTC | 事件 | 判定 |
|---|---|---|
| 08:40:38.377 | `turn committed:` 首句 16 字（eou 21ms，ordered 首句） | 正常 |
| 08:40:38.377 | `caption final published (deferred)` published=1 **dropped=0** | 字幕正常 |
| 08:40:39.348 | `receipt_done accepted → body release` | 正常 |
| 08:40:39.350 | `aec warmup active, disabling interruptions for 0.50s` | 保护窗只有 0.5s |
| 08:40:39.376 | turn1 body first frame（no filler） | 正常 |
| **08:40:42.127** | **turn1 aborted**（synth 18 / spoken 11）← `interrupt telemetry interim='啊急'` | **自打断①** |
| 08:40:42.127 | `turn committed: 啊急` eou 449ms → **新起 turn2** + `filler bucket=barge '你说'` + LLM | 起新轮 |
| 08:40:42.128 | published=2 **dropped=0** | 字幕照发 |
| **08:40:55.877** | **turn2 aborted**（synth 50 / spoken 50）← `interim='付出'` | **自打断②** |
| 08:40:55.877 | `turn committed: 付出` eou 400ms → **turn3** + `filler barge '行！'` | 起新轮 |
| 08:41:05.354 | `S1v3 preflight emitted (silence=400ms quiet=159ms tail='退出')` + `speculation skipped: swallow-word tail` | 退出预检正常 |
| 08:41:05.727 | `session_exit utterance swallowed: '退出' path="exact"` + `session_exit signal sent seq=1 reply_kind="general"` | **退出正确** |
| 08:41:05.727 | turn3 aborted（synth 44 / spoken 41），published=4 **dropped=0** | 硬停 |
| 08:41:05.7975 | `session_exit ack seq=1 matched=true accepted=true already_done=true` | ack 在 cancel **之前** |
| 08:41:05.7977 | `control cancel seq=14 cancelled=false already_done=false had_turn=false` | 无在途轮可取消 |
| 08:41:05.90→06.00 | user track MUTED → disconnected → room deleted → `job closed uptime_s=29` | 正常收口 |

- **旧轮命运**：两次都是**硬停 + 历史截断**，`exit="Aborted"`；**没有 pause、没有 resume**。
  假打断 resume 路径（`false_deadline`）只对 pause 生效，这两次直接走到 commit，所以一次都没进。
- **是否新起 turn/filler/LLM**：两次都起了，且 filler 都是 `bucket=barge boost=true`（打断桶）。
- **与你 B54 表的对齐**：你记的两条额外 2 字 final（设备 CST 16:40:41.397／55.144）按**顺序**对应上面
  自打断①②，不做跨钟相减。

---

## 4. C 房最小账（trace `9702e0bf-9b15-4b31-8010-f552db81f46b`）

| UTC | 事件 | 判定 |
|---|---|---|
| 08:45:15.625 | `turn committed:` 首句 8 字（eou 45ms） | 正常 |
| 08:45:15.625 | published=1 **dropped=0** | 正常 |
| 08:45:16.373 | `tts first clause split` 首句切出 **「雨琪，好呀，」6 字** | 记住这 6 个字 |
| 08:45:16.659 | aec warmup 0.50s；16.674 body first frame | 正常 |
| **08:45:19.174** | **turn1 aborted**（synth 23 / **spoken 7**）← `interim='好起'` | **自打断①** |
| 08:45:19.174 | `turn committed: 好起` eou 422ms → turn2 + `filler barge '嗯！'` | 起新轮 |
| 08:45:24.674 | `audio in (10s) mean_amp=42` | 含真人首句 |
| 08:45:34.724 | `audio in (10s) mean_amp=3` | **近静默** |
| 08:45:44.773 | `audio in (10s) mean_amp=4` | **近静默** |
| **08:45:46.474** | **turn2 aborted**（synth 134 / spoken 117）← `interim='你说'` | **自打断② ＝ 疑似首次退出** |
| 08:45:46.474 | `turn committed: 你说` eou 419ms → turn3 + `filler barge '行！'` | 起新轮 |
| 08:45:52.674 | `S1v3 preflight tail='退出'` | 第二次退出预检 |
| 08:45:52.723 | `session_exit utterance swallowed: '退出' path="exact"` + `signal sent seq=1` | **退出正确** |
| 08:45:52.796297 | `session_exit signal terminated by cancel` | cancel 先到 |
| 08:45:52.796360 | `control cancel seq=18 ... had_turn=false` | |
| 08:45:52.796392 | `session_exit ack seq=1 **matched=false** accepted=true already_done=true` | 见下 |
| 08:45:52.97 | room deleted，`job closed uptime_s=38` | 正常收口 |

### 4.1 「C 第一次退出无效」——Worker 侧的真实情况

**那一刻 Worker 收到的文本是「你说」，不是任何退出词、退出尾部形态或其变体。**
因此：零 `session_exit` 识别、零 swallow、零 signal、零 ack。它被当成一句普通用户话，
commit 成 turn3，配了打断桶 filler「行！」并走了 LLM。**用户听到的就是「小可又开始说话」而不是退出。**

`exit_tail` 也没有漏网嫌疑：「你说」既不是精确退出词，也不以任何强意图退出词结尾。

**我不把它定成回声，也不把它定成用户语音。** Worker 侧分不出来，能说的只有：
- 它出现在两个 `mean_amp=3/4` 的近静默 10 秒窗之后，说明**那前后确实有一段声音进了上行**，
  不像「持续回灌」；
- `eou_ms=419` 说明它走的是常规判停，不是碎片。

要定这一条，需要**端侧那一刻的原始 ASR final 与上行电平**（你那边有），Worker 日志到此为止。
按你的要求，我不用出口修复去冒充解决这条——**这是一次识别错误或输入缺失，不是出口缺失。**

### 4.2 `matched=false` 不是失败

最后那次退出**执行成功了**：swallow → signal sent → 硬停 → 房间关闭。
`matched=false` 的成因是 Android 的 `cancel` 比 ack 早到 **32 微秒**，
`session_exit signal terminated by cancel` 先把 `exit_pending` 清了，随后 ack 找不到待匹配记录。
B 房 ack 早于 cancel 193 微秒，所以 `matched=true`。
**同一份代码，两种到达顺序，两个回执值。** 这是记账的顺序副作用，本轮没有用户可见后果，
但它说明这个字段**不能当「退出成功与否」的判据**——该看 `accepted`/`already_done` 和房间是否关闭。

---

## 5. 根因：四次自打断都只碰到一道门，而那道门对错转结构性无效

### 5.1 哪几道门在场

| 门 | 生效条件 | B/C 四个时刻是否在场 |
|---|---|---|
| 开场单字门（`n_chars==1`） | 会话起 **15s** 内（`LOCAL_AUDIO_ECHO_WINDOW_MS` 默认） | B① ≈5.4s ✅ / C① ≈4.7s ✅ 在场；B② ≈19.2s ❌ / C② ≈32.0s ❌ 已出窗 |
| 开场 echo bank LCS 门 | 同上 | 在场时也 miss：bank 是**本地招呼语 15 条**，与 TTS 正文无关 |
| 开场重叠放宽门（`overlap`） | 同上 **且** `user_commit_count == 1` **且** `!commit.input_ended` | **结构性永不进入**，见 5.3 |
| TTS 精确子串门（`tts_substring`） | 播放中 or 播完 800ms 内；≥2 字 | **四次全在场**，四次全 miss |

### 5.2 子串门为什么四次全 miss

判据是 `normalize_echo(最近播出文本).contains(normalize_echo(用户文本))`。
`normalize_echo` 只做「滤掉非字母数字 + 小写」，**没有拼音、没有音近归一**。于是：

- C①：正在播的是 **「雨琪，好呀，…」**，ASR 转出 **「好起」**。
  「好」在里面，「起」不在（在里面的是同音的 **「琪」**）。整串 `contains` ⇒ **false**。
- B①「啊急」、B②「付出」、C②「你说」：与当时 TTS 正文无任何字符交集 ⇒ **false**。

**这和你 B49 记的「雨洁 ⊄ 雨琪」是同一个洞，只是这次数据更硬**：
这道门在该 unit 当前 journal 全量（2026-09-11 07:54 → 09-12 11:52）**命中 0 次**。
一道从没响过的门。

### 5.3 `user_commit_count==1` 那条候选：**B/C 没进过，别改**

你要我先证实再动，我证实了：**两房都没进入开场重叠门**，理由有两层，任一层都足够：

1. 该门要求 `!commit.input_ended`。ordered 首句代次的 commit `input_ended=true`，被代码里那条
   B23 条件显式排除 ⇒ **commit #1 就进不去**。
2. `user_commit_count` 在函数开头就 `+= 1`，所以 commit #2 起 count ≥ 2 ⇒ **后续也进不去**。

两层相乘 ⇒ 对 ordered 首句会话，这道门**永远不会进入**。
journal 全量 `local-audio echo suppressed (opening overlap)` 命中数 **0**，与推导一致。

所以「被吞句也递增 count」这条**不是 B/C 的漏点**，本轮我一个字都没动。
（它仍然是个真问题，但它的受害面在**非** ordered 首句的路径上，该单独立项。）

### 5.4 真正响过的只有单字规则

该 unit journal 全量 18 次 `local-audio echo suppressed (opening window)`，
**18 次全部 `slot=single-char`**，被吞文本全是单字：`好`×8、`啊`×4、`鞋`、`略`、`琪`、`行`。
echo bank 的 LCS 分支一次都没命中过。

**一句话概括现状**：这台设备上唯一真正起过作用的回声防线，是「开场 15 秒内的单字」。
**2 字及以上、或 15 秒之后，目前没有任何防线。** B/C 的四次自打断，正好整齐地落在这两类里。

---

## 6. 你列的四条，逐条判定

| 你的编号 | 判定 | 依据 |
|---|---|---|
| 1 `user_commit_count` / 开场宽松门只认第 1 次 | **B/C 未进入该门**，本轮不动 | §5.3 两层排除 + 全量 0 命中 |
| 2 控制原始 final 被合并后失去语义 | **B/C 未发生**。两房「退出」都是独立 final 且 `path="exact"` 正确命中 | §3/§4 的 `swallowed … path="exact"` |
| 3 TTS 告别回听先过 EXIT 门 | **B/C 未观察到**，不动 | 两房 EXIT 各只命中 1 次，均在真人退出时刻 |
| 4 设备命令缺受信 trace | 与本轮无关，后置 | 两房无设备命令 |

**结论：四条候选没有一条能解释 B/C。** 按你「不一口气全改」「有实锤再小修」的要求，
**本轮 Worker 逻辑零改动、零部署**。线上 `71e42ab0…` 仍由 `0093c85e8` 构建（见 §9）。

---

## 7. 同一坐席还有第三房，它是我 B53 改动的正锚

你 B54/B55 只给了 B、C。同一次坐席在 C 之后还有一房，**08:47:28–08:47:54，26 秒**：
trace `1f6e5be4-e1f6-4f6f-8a29-c97d33e267ed`，房 `…0010-1789202847`。

| UTC | 事件 |
|---|---|
| 08:47:29.320 | 首句「小可小可测试一下」eou 42ms，published=1 |
| 08:47:31.613 | `local-audio echo suppressed (opening window): '好' slot=single-char` → `caption final suppressed (echo; 已发空 final 撤回 interim 并收尾)` |
| 08:47:32.664 | 同上，`'行'` |
| 08:47:36.814 | `turn committed: 继续` eou 748ms，filler `bucket=gen`（**非** barge） |
| 08:47:43.864 | `turn committed: 继续说` eou 827ms，filler `bucket=gen` |
| 08:47:49.914 | `turn committed: 那说个长点的` eou 597ms，filler `bucket=task` |
| 08:47:54.114 | `session_exit utterance swallowed: '退出' path="exact"` + signal + ack → `job closed uptime_s=26` |

这房有三件事值得你收进账：

1. **我 B53 的字幕改动在这里有真实正样本**：两次单字回声被吞，字幕走了「发空 final 撤回 interim 并收尾」，
   没有悬空 interim。**B/C 两房 `dropped_total` 全程 =0，所以 B/C 对我这个改动零信息量**——
   我不拿 B/C 说我修好了。
2. **三次正常续聊全部正确**，且 filler 桶是 `gen/task` 而不是 `barge` ⇒ 系统认得出「这是正常轮不是插话」。
3. **一个干净的判别器**：这房三次 `interrupt telemetry` 的 `interim=''`（空），
   而 B/C 四次全是非空（`啊急/付出/好起/你说`）。
   **空 interim ＝ 自然轮结束；非空 interim ＝ ASR 文本驱动的插话。** 这条以后可以直接拿来分类。

---

## 8. 分账：underrun 与其它观察

**Worker 侧 underrun（按房按轮，不与端侧合写）**：

| 房 | turn1 | turn2 | turn3 |
|---|---|---|---|
| B | 0 次 / 0ms | **1 次 / 545ms** | **1 次 / 333ms** |
| C | 0 次 / 0ms | 0 次 / 0ms | **1 次 / 498ms** |

端侧你记的是两房均 0，两个口径各记各的，不合并。

**另一条稳定现象**：B/C 每一个打断轮开头都有
`WARN capture_frame 失败,进入重试窗口 … InvalidState`，随后 `capture_frame 重试成功,本轮保住 tries=1`，
**4/4 全部发生、4/4 全部自愈**（约 18–21ms）。不影响本轮结论，但它精确地只在
「abort 旧轮 + 立刻起新轮」这个时刻出现，记一笔。

**上行电平（同房 `audio in (10s)` 原值，不跨房比）**：B 房 40 → 17；C 房 42 → 3 → 4。
C 房两个近静默窗后仍产出了「你说」，B 房 `mean_amp=17` 的窗里产出了「付出」。
10 秒均值盖不住 0.5 秒突发，**这两个数不足以定声源**，只作为线索列出。

---

## 9. 本轮我改了什么 / 没改什么

**改了（只有测试，未部署）**：

- `src/caption_gate.rs` 新增 `b55_bc_misrecognitions_are_not_control_outlets`：
  把 B/C 四条真实文本钉成「不是控制出口」，防止以后有人用「扩控制白名单」的方向去修这个洞
  （那个方向会把回声门整个架空）。带正锚：同调用形态下「停」「退出」仍分得出来。
- `src/textproc.rs` 新增 `exit_tail_does_not_fire_on_question_about_reentry`：
  你点名的长句反锚「退出后告诉我怎么进入」。

**测试数 310 → 312，`cargo test` 全绿，`cargo clippy --tests` 0 error（13 warning 全为既有）。**

提交 `934a336bc5efb365c4b13467d3065404ce021130`，已推 `origin/feat/ordered-pcm-input`（远端逐字核对一致）。
⚠️ **它的父提交才是线上那一份**：灰度跑的 `71e42ab0cf9d595ca799d0d62eff05fba43a5b857202c4ca6121a278c5a7b246`
由 `0093c85e80daaf899260a3bd71d0c5a098ced6cd` 构建，本提交**只动测试文件、零运行期改动、未部署**。
你复核 B/C 行为时请继续对 `0093c85e8`。

**负向验证（两条都单独验过，不接受「跟着别人红」）**：

| 注入 | 期望 | 实际 |
|---|---|---|
| `control_outlet_kind` 把 2 字文本误判成 `stop` | 新增数据锚红 | ✅ `b55_bc_misrecognitions_are_not_control_outlets` 红（另 2 条既有测试也红） |
| 尾部退出匹配 `ends_with` → `contains` | 新增长句反锚红 | ✅ `exit_tail_does_not_fire_on_question_about_reentry` 红 |
| 删 `QUESTION_MARKERS` 里的「怎么」 | —— | ❌ **没红**。见下 |

第三条是我**自己抓到的判据误解**：我起初以为「退出后告诉我怎么进入」是靠疑问豁免保住的，
注入后发现先红的是更早那条既有断言，我的新断言根本没被执行到（同一函数内被遮蔽）。
**把它拆成独立测试函数**重跑，才发现真相：这句话之所以安全，是因为退出尾部匹配是 `ends_with`，
而这句以「进入」结尾——**跟疑问豁免没关系**。
所以：`EXIT_TAIL_MATCH` 这条线上真正的护栏是**后缀匹配**，谁要是哪天把它放宽成 `contains`，
你这条反锚立刻失守。现在有测试守着了。

**没改**：Worker 任何运行逻辑、打断/退出语义、AEC、音量、短句阈值、ready、生产、Android。未部署。

---

## 10. 我这轮的取证纪律自曝两条（都可能污染结论，已纠正）

1. **`audit_marker` 不是可用通道**。我在三个回声门和 `check_hotword` 埋的 `audit_marker`
   只在**采集开启时**才打日志。禁录 override 生效后它恒不输出——
   「零 `echo_gate_*` 行」既可能是门没命中，也可能是打点本身没能力发信号，两者同形。
   **改用有信号能力的通道**：三道门各自的无条件 `info!` + `dropped_total`，
   并用「全量 18 次 opening-window 命中」当正锚证明这条通道确实会响。
2. **journald 输出带 ANSI 转义**，`field\e[0m\e[2m=\e[0m value`。
   我第一次 `grep -F "dropped_total="` 得到 0，而同窗 `caption final published` 有 8 行——
   自相矛盾才发现。**所有字段级计数都先 `sed -r 's/\x1B\[[0-9;]*[mK]//g'` 去 ANSI。**
   §3–§5 的所有计数都是去 ANSI 之后重新数的。

---

## 11. 建议的下一步（等你点头，我不自行开工）

按你的优先序，我认为现在值得做的只有一件，而且它**不是调灵敏度**：

**把子串门的判据从「字符精确子串」抽成一个可测的纯函数，先只加观测、不改判决。**
理由：这道门是四次自打断唯一在场的门，而它全量 0 命中——
在有人（我或你）改它的判据之前，我们连「改宽多少会误伤真人短应答」都没法算。
抽成纯函数之后可以拿 B/C/D 三房的真实文本对回放，**先量出误伤面再决定动不动**。

**我明确不建议**的：任何形式的「播放中 2 字一律吞」。C② 很可能就是用户的第一次退出——
真按这个方向修，结果是**用户的退出被更彻底地吞掉**，比现在更糟。

还悬着的（本轮未碰）：ready 补确认端侧仍 0、声源仍未知、
`user_commit_count` 那条在非 ordered 路径上的影响。

---

**证据来源**：`voice-worker-firstturn.service` journal（08:38–08:49 UTC 窗，逐房过滤 + 去 ANSI），
进程 `/proc/2734957/{environ,exe}`，源码 `0093c85e8` 工作树。
未下载 WAV、未外派 ASR、未开采集、未抄全房名/SN/凭据、未复制正文整段。

署名：cc（Claude）| 2026-09-12 20:02 CST
