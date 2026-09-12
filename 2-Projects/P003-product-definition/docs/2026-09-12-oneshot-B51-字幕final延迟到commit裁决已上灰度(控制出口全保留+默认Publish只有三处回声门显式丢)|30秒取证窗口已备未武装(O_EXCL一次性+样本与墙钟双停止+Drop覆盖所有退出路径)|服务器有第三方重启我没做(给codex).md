# B51｜§4 已上灰度、§5 **已武装（可以开始）**；另有一件服务器上的事必须先说

**先说不属于本任务但必须报的一件事：今天 06:47:47 和 06:48:18（UTC，= 14:47/14:48 CST），有人把 64.90 上的全部 voice unit 重启了两次——不是我做的，也不是部署。**

我核过了：两个二进制哈希都没变（生产仍 `f3707e7e…`、磁盘 mtime 停在 09-06 23:49:50；灰度仍我 B48 那份），`/root/realtime-voice-agent` 树近 3 小时零文件改动，unit 与 env 文件也没动。所以是**纯重启，不是发版**。`aiops` 那个自动化今天只跑过 `inspect`（91 次），且它的 restart 目标是另一个 unit，排除。来源是一个 root ssh 会话——root 登录不记命令，**我无法证实是谁，所以不猜**。

影响两件事，你判断：

1. 生产 `voice-worker-rust` 的 MainPID 从 **2017631 → 2720004**，ActiveEnter 变成 06:48:18 UTC。之前所有回执里的「生产 2017631 未动」这个锚**从此失效**，后续对账请用新 PID。
2. 🔴 **这会吃掉 §5 的一次性录音授权**：窗口是 `O_EXCL` 占坑的，一次授权只录一次。如果录音期间有人又重启灰度，Drop 会写一份**残缺**的 WAV，claim 也就消费掉了。所以开录之前，请先确认那位在做什么、或者约一个不会被打断的窗口。补救是人工删 claim 文件 —— 那是一次可审计的重新授权，不是自动续期。

以下是本轮两项交付。

---

## 一、§4 字幕 final 延迟到 commit 裁决（已上灰度，开关开）

### 1.1 你那条纠正成立，我按它改的

你说「`pipeline.rs:1860–1867` 在 on_final 发 `tr.user_final`，过滤实际在 on_tick / poll_commit，并不在同一个函数，不能只把一行移到相邻位置就声称改好」——**完全正确**，而且比这还麻烦一层：`turn::Gate::on_final` 是 `pending.push_str`，**多条 ASR final 会合并成一次 commit**。所以「移一行」不仅位置不对，粒度也不对。

实际做法（新模块 `caption_gate.rs`）：

- final 到达时**立刻轮换段 id**（`take_seg_for_deferred_final`）但**不发包**，把 `(seg, text)` 压进缓冲。立刻轮换是关键——否则下一句的 interim 会复用同一段 id，覆盖掉这段还没发的 final，正是你说的「不能把下一句并到残留 interim 上」。
- commit 裁决时整批发或整批丢，按原序，不重不漏。
- 段 id 在 final 那刻就定下并推进，**被丢弃的段同样推进**。

### 1.2 默认 Publish，只有三处显式丢——控制出口按你要求全保留

`on_tick` 有 **8 条 return**，我逐条分类过：

| return | 语义 | 判决 |
|---|---|---|
| `local-audio echo suppressed (opening window)` | 单字 / 本地回声库 | **Drop** |
| `local-audio echo suppressed (opening overlap)` | 开场重叠 LCS | **Drop** |
| `echo suppressed ⊂ recent tts` | TTS 子串门 | **Drop** |
| `{kind} utterance swallowed` | **STOP / SESSION_EXIT 吞句** | **Publish** |
| `asr 命中被账本压制` | 同句已有所有权/提案 | **Publish** |
| `start_device_command` | 设备命令轮 | **Publish** |
| 音量超范围 → 固定提示 | | **Publish** |
| 普通 LLM 轮 | | **Publish** |

判决默认 `Publish`，**只有那三处回声门显式调 `mark_echo_drop()`**。你点名的边界因此结构性成立：`SESSION_EXIT_SIGNAL_ENABLED=0` 的部署仍能靠 LOCAL final 退出；设备命令与账本压制的出口没被当回声删掉。

将来 `on_tick` 新增 return 分支**自动继承 Publish**——失效方向是「多发一条可见字幕」，不是「静默丢失」。

裁决的落地放在 `on_tick` 的**包装函数**里（`on_tick` → `on_tick_inner` + `flush_caption_finals`），**8 条 return 一条都绕不过去**。这是我能想到的唯一一种「加新分支不会漏」的写法。

### 1.3 不重不漏的根据：与 `turn_gate.pending` 严格一一对应

`turn::Gate::pending` 只有两个写点——`on_final` 追加（**空串直接 return 不入**）、`poll_commit` 整体 `mem::take`。**没有「不 commit 就丢弃」的路径。** 本门照此镜像：空 final 不入缓冲（由调用方原路立即发，空 final 在端侧不启动等待），非空一条一条入，裁决时整体 drain。

### 1.4 你要的 wire 发送计数

新日志行，**数的是实际发包动作不是 contract journal**：

```
caption final published (deferred) room=… segments=N published_total=… dropped_total=…
caption final suppressed (echo)    room=… segments=N published_total=… dropped_total=…
```

### 1.5 一个我必须标出来的代价

字幕出现时刻从「ASR final」推迟到「commit 裁决」，**延迟 = 现有 EOU 判停时长，我没有新增任何等待**。实测量级：首句 ordered 路径 `eou_ms` 20–45ms（无感）；RTC 路径那次自打断的 commit 是 `eou_ms=441`。**RTC 路径最坏约 0.45 秒**。我认为这更正确（字幕出现 = 系统真的接受了这句），但它是产品可见变化，先标出来由你和川哥判。

### 1.6 没做也不打算做的

不加通用事件总线；不动 120 秒上限；不新增 EOU 等待、不阻塞媒体、不改投机时序；**不承诺「final 必有回复」**——工具/生成失败仍可能没有回复，端侧有界保护请继续保留。

---

## 二、§5 一次性 30 秒取证窗口（代码已上灰度，**开关未设 = 未武装**）

### 2.1 为什么另起一个而不是改 SnapshotSink

你点名了：`SnapshotSink` 是「每个判停事件切一段」的形态，单 job 默认 50 份 × 每份 8 秒窗口，**没有任何总时长门**，50×8s 远超 30 秒授权。改它的配额语义会牵动既有 EOT 采集口径。所以新起 `audit_capture.rs`：**单份、连续、硬顶**。

### 2.2 护栏逐条对应你的 §5

| 你的要求 | 实现 | 单测 |
|---|---|---|
| 最多 30 秒 | `MAX_SAMPLES = 480_000` **是常量**（16k mono = 30.0s），env 只能调小不能调大 | `max_is_hard_capped_at_30s` / `smaller_max_is_honored` |
| 绑定单调时间 | 样本上限 **与** 单调墙钟上限双停止，哪个先到算哪个；`stop_reason` 落日志（`samples_cap`/`wall_cap`/`session_end`） | `wall_clock_also_stops_the_window` |
| 一次性、不自动再录 | `O_EXCL` 原子创建 `CLAIMED` 占坑，已存在即放弃；**worker 重启也不复活**（claim 在磁盘上） | `claim_is_one_shot` |
| 普通自动欢迎房不能抢占 | 只对 `first_turn_rtc=true` 的真实首句 ordered_pcm 轮武装；presence_return 房结构性为 false | `should_arm_matrix` |
| 退出/断开提前停 | 写盘在 `Drop` 里——正常结束、fatal 早退、panic 展开**每条路径都会走到**，且只写一次 | `drop_writes_exactly_one_wav_0600` |
| 不覆盖不轮转 | 满了只计数丢弃，窗口逐样本原封不动（授权是「一次 30 秒」不是「最近 30 秒」） | `full_window_does_not_rotate` |
| 未用授权不创建音频文件 | 零样本不写；开关没设时连目录都不建 | `zero_samples_writes_no_file` / `arm_from_env_is_fail_closed_without_env` |
| 700 / 600 / umask 0077 | 目录 `0o700`、WAV `0o600`；unit 已有 `UMask=0077` | 同上（测试里实测 mode） |
| 不新占麦、不改路由、不加第二个进程 | 挂在现有 `mic.next()` 那条上行上，只做一次 `extend_from_slice`，不进任何判定链 | — |
| `check_hotword` interim 分支要有取证点 | **不另开采集口**——本窗口是连续的，那一刻本来就在窗口里。落的是**索引**：`audit capture marker event=check_hotword_interrupt offset_ms=… samples=…`，**不带转写正文**。三处回声门同样落锚 | — |
| 只交 SHA/时长/样本数，不贴音频 | Drop 日志只给样本数、时长、字节数、停止原因、文件名 | — |

格式：16kHz 单声道 s16（`NativeAudioStream::new(track, 16_000, 1)`，与你的规格一致），30 秒 = 480000 样本 = 960000 音频字节，不含头。捕获的是 **worker 实际收到的上行**，不冒充未经 HAL 处理的麦克风原始信号。

### 2.3 一处合同必须修正：**目标 trace 无法事先指定**

你写「只对一个明确目标 trace」。做不到——**trace 是会话开始那一刻由 Session API 铸的，事先没人知道它**。我用的替代判据是：

> 开关开 **且** 是真实首句 ordered_pcm 轮 **且** `O_EXCL` claim 抢到 → 录这一次。

实际 trace 事后从文件名（`uplink-<trace>.wav`）和 journal 拿。效果等价于「指定设备的下一次首句会话，且只此一次」，并且自动欢迎房结构性抢不到。如果你要更严的绑定，请给一个事先可知的量，我照改。

### 2.4 本轮**没有**做的（等你说开始）

- **`ONESHOT_AUDIT_CAPTURE_ENABLED` 未设**，实测进程环境该键命中 **0**，灰度工作目录下取证目录 **0 个**。代码在，窗口没武装。
- **24 小时清理任务未登记**。你要求「先注册并回读再开始录音，期限从录音起算」——所以它必须和开关同时上，不能现在挂一个空转的。开录时我会一次做完：`systemd-run --on-active=24h` 注册 → `systemctl list-timers` 回读确认 → 才设开关重启。回执给你 timer 名、下次触发时刻、覆盖路径。
- 默认不复制到 Air；需要你听证时再谈安全传输。

### 2.5 ✅ 已补完并武装（本节是 15:3x 补记，早于本文件其余部分的时间戳）

上面 2.4 写的「未武装」已经不成立了——两件事都做完了，**按你 §5 规定的顺序**：先登记并回读清理任务，再开开关。

**① 24 小时清理任务：已登记、已回读、并且实测过真的能删。**

```
oneshot-audit-cleanup-20260912.timer  →  下次触发 Sun 2026-09-13 07:35:39 UTC
ExecStart = /bin/bash -c rm -rf /root/oneshot-audit-20260912 && logger -t oneshot-audit "cleanup done: …"
```

我没有只看它「登记在册」就算数：造了两个假文件（`probe.wav` + `CLAIMED`）→ 手动 `systemctl start` 那个 service → 目录确认消失、`Result=success`、`ExecMainStatus=0`、syslog 锚 `cleanup done` 命中 1 → 再确认定时器**仍在册**（手动跑一次没把它取消）。**这个安全网是验过的，不是声明的。**

注意期限口径：定时器从**登记时刻**起算 24 小时，录音发生在登记之后，所以实际删除时刻**早于**「录音起算 24 小时」。比你要求的更严，方向是安全的。

**② 取证开关：已开，进程环境实测。**

| 项 | 实测 |
|---|---|
| 灰度 PID | 2725881 → **2727243**，SubState=running，exe 仍 `83a8e38f…`（只重启不换二进制） |
| `ONESHOT_AUDIT_CAPTURE_ENABLED=1` | 命中 1 |
| `ONESHOT_AUDIT_CAPTURE_DIR` | `/root/oneshot-audit-20260912`（**专属根，不与任何既有快照树混**） |
| `ONESHOT_CAPTION_DEFER_ENABLED=1` / `ONESHOT_READY_CONFIRM_ENABLED=1` | 各命中 1 |
| `EOT_SNAPSHOT_DIR` / `INTERRUPT_SNAPSHOT_ENABLED` | 各命中 **0**（两条既有采集通道仍关） |
| Umask | 0077；`registered worker` 1 次 |
| 取证目录 | **尚不存在**——没有合格会话跑过，零文件。未用授权不建任何文件 |
| 灰度专属 env 键数 | 15 → 17（只加这两个键） |
| 三个共享 env 对 `ONESHOT_AUDIT_CAPTURE` 命中 | **0 / 0 / 0**（键总数 37/11/41 作正锚） |
| 生产 `voice-worker-rust` | 2720004 / 06:48:18 UTC / NRestarts 0，**本次未动** |

**→ 可以开始。**

### 2.6 但开始之前，有两件事必须由你把住

1. 🔴 **武装之后，下一个合格会话就是被录的那个，不管是谁触发的。** 判据是「首句 ordered_pcm 轮 + 抢到 `O_EXCL` 占坑」。设备上首句产品门现在是 1，所以**孩子随手唤醒一次就会把这次授权消费掉**。请你通知川哥之后**尽快做那一轮**，中间别让设备被别人用。
2. 🔴 **本文件开头那个第三方重启还没定性。** 如果录音期间它再来一次，Drop 会写出一份**残缺** WAV，而 claim 已经消费。开录前最好先确认那位在做什么。

两种情况的补救都一样：删掉 `/root/oneshot-audit-20260912/CLAIMED`，就是一次**可审计的重新授权**（不是自动续期）。要我删，说一声。

### 2.7 录完之后我会交什么

只交这些，**不贴音频、不贴 base64、不贴房名**：文件 SHA256、样本数、时长、`stop_reason`（`samples_cap` / `wall_cap` / `session_end`）、trace、以及取证锚点表——

```
audit capture marker event=check_hotword_interrupt   offset_ms=… samples=…
audit capture marker event=echo_gate_local_audio     offset_ms=… samples=…
audit capture marker event=echo_gate_overlap         offset_ms=… samples=…
audit capture marker event=echo_gate_tts_substring   offset_ms=… samples=…
audit capture 收口: samples=… duration_ms=… bytes_audio=… stop_reason=… window_wall_ms=…
```

拿偏移就能在 WAV 里定位到「打断发生的那一刻」。需要你听证时再谈怎么安全送到 Studio 受保护目录。

**建议的那一轮按你 §5 原话**：说「小可小可，说个长句测试一下」，然后**保持安静、不主动说停**，看是否仍自打断；结束触摸「不聊了」收口。没复现就标 NOT_REPRODUCED，不延长、不自动再录。

---

## 三、部署锚

| 项 | 值 |
|---|---|
| 提交 | `72af0964ce6834ad6e3a8ce5363dc48f86f459fd` |
| 二进制 SHA256 | `83a8e38f6e3199395474c6f31fe359972c0adeb3f90f84fba075608a525e5572` |
| 三点对撞 | 构建机 / Air 中转 / 64.90 落地，三处逐字相同 |
| 灰度 PID | 2719995 → **2725881**，SubState=running |
| 运行中 exe | 读 `/proc/2725881/exe` 校验 = 上面那个 SHA |
| 上一版 | `.prev` = `241585162416cf…`（B48/B49），备份 `/root/b50-backup/` 含二进制+env+unit |
| 灰度专属 env | 键数 14→15，只加 `ONESHOT_CAPTION_DEFER_ENABLED=1` |
| 共享 env | `.env` / `poc-eou.env` / `rust-worker.env` 对两个新键命中均 **0**（键总数 37/11/41 作正锚） |
| 进程环境实测 | `CAPTION_DEFER=1` ✓ / `READY_CONFIRM=1` ✓ / `AUDIT_CAPTURE` 0 ✓ / `EOT_SNAPSHOT_DIR` 0 ✓ / `INTERRUPT_SNAPSHOT_ENABLED` 0 ✓ / `AGENT_NAME` 1（正锚） |
| Umask | 0077；`registered worker` 1 次；错误数 0（配 691 行 info 正锚）；新增采集目录 0 |
| 生产 | `voice-worker-rust` 2720004 / 06:48:18 UTC / NRestarts 0，exe `f3707e7e…`，本次换装前后逐字未变；colleague 2720057、console 2720025 未动 |

回滚（零编译）：`install -m 755 …/voice-rust-worker.prev …/voice-rust-worker && systemctl restart voice-worker-firstturn`，或只删 env 那一行 restart（退回默认关）。

## 四、验证

- 测试 **285 → 304**，0 失败；Air（rustc 1.94.1）与构建机（1.98.0）两套工具链各跑一遍均 304。`cargo clippy --all-targets` RC=0，两个新模块告警 0（全量 17 条历史告警仍在，证明该 grep 有区分力）。
- 负向验证，每条都先确认 diff 落地再跑：
  - `caption_gate` 四注入 → 红 2 / 5 / 5 / 1 条（commit 裁决不生效 / 回声门失效 / 默认判决改成 Drop 砍掉控制出口 / 发完不清缓冲串到下一句）。
  - `audit_capture` 七注入全红（拿掉 30 秒硬顶 / 占坑不互斥 / 满了改轮转 / 去掉非首句轮门 / 零样本也建文件 / 拿掉墙钟条件 / 调小无效）。

### 自曝：有两条注入第一次**没变红**，是我的测试有洞，已补

1. **轮转注入没被抓到**——我的测试往缓冲里灌的是**全同值**样本，`drain+extend` 之后长度和首样本都不变，两种实现完全同形。改成斜坡样本并逐样本比对整个窗口。
2. **删掉 `first_turn` 门没被抓到**——测试打的是 `arm_from_env`，而测试进程本来就没设 env，**前一道 env 门先返回 None**，后面的门等于没测。把武装判据抽成纯函数 `should_arm(enabled, first_turn, dir, trace)`，矩阵逐条锁死，并配一个「四条齐全必须武装」的正锚。

补完之后重跑这两条注入，分别红 `full_window_does_not_rotate` 和 `should_arm_matrix`。

## 五、诚实边界

- **§4 的 pipeline 接线没有单测**：8 条 return 的分类、3 个 `mark_echo_drop` 落点、`on_tick` 包装，只有编译期 + 人工复核 + 真机日志。纯逻辑部分（`caption_gate`）测试覆盖完整。机械可查：`mark_echo_drop` 3 处、`on_commit_decided` 1 处、`flush_caption_finals` 1 处。
- 本轮**零真机会话**通过新二进制，换装后灰度还没接到 job。上一版（B48/B49）在真机跑过 4 个房。
- 两个自打断的洞（interim 绕门 / 子串判据对错转无效）**一个都没修**。没有声学证据之前我不动打断灵敏度。
- 整体仍 **DEGRADED**。
- §5 窗口**已武装**（2.5 节），清理任务已验过；等你协调那一轮。

署名：cc（Claude）| 2026-09-12 15:32 CST

（2.5–2.7 节为武装后补记，时间 15:37 CST）
