# B33｜B32 三件事的回执：代码锚 + 取证能力 + turn-2 空档拆解

日期：2026-09-12。**代码与测试已就绪，未部署。** 按你 §4「先交代码锚、测试与部署计划，再对齐一次诊断装机/切换窗口」执行，窗口由你定，我不自选。

## 1. 结论先行

- **A（ready 真实发送结果）已实现。** 你的判断完全正确：`publish_json` 是 `tokio::spawn` 即返回，那行 `published` 只证明**排进了队**；而 `publish_data` 的失败原本只落 `debug!`，INFO 级 journal 里根本看不见——B31 查到「worker 发了、设备走兜底」就断在这。
- **B（打断路径取证快照）已实现，默认关。** 关闭时连对象都不构造，不登记、不落盘、不多占一字节环。
- **C（turn-2 空档）已用现有日志拆开**：1100ms 不是「垫句播完后空转等正文」，而是 **filler 只有 960ms，生成链要 2099ms**。另有一个真发现：**turn-2 没有做首句切分，TTS 一次收了整段 85 字**，turn-1 做了（25 字）。
- **一处你要求但当前未满足的**：原始音频权限。现有快照是 **755 目录 / 644 文件**，unit `UMask=0022`，不是你要的 700/600。这是既有 EOT 采集就有的口径，不是本轮引入，但得在装机时一并解决（方案见 §5）。

## 2. 你要的代码锚（§6 第 1 项）

| 项 | 实取值 |
|---|---|
| 分支 | `feat/ordered-pcm-input` |
| 提交 | `5dff4583a683c3713bfb4d64d3b1987f48703b10` |
| 父提交 | `93dfb62be82a1b1d294a9797cc91b688913fbdc3` ← **正是你逐字验过的那个** |
| 已推 origin | 是，`origin/feat/ordered-pcm-input` HEAD 与本地一致（本地领先远端 0） |
| 改动面 | 2 文件，+297 −2；只有 `rust-worker/src/{pipeline,eot_snapshot}.rs` |
| 测试 | **265 通过 / 0 失败**（基线 259，+6） |
| 新增告警 | **0**（基线 2 → 本轮 2，把两个文件退回原版实测对撞，不是推断；两条都在我没碰的 `say_defer.rs` / `textproc.rs`） |
| 构建门禁 | glibc 全部 ≤ 2.39 ✓；libstdc++ 最高 GLIBCXX_3.4.31 ≤ 3.4.33 ✓（门禁锚**目标机 64.90** 的能力，不是构建机的） |
| 二进制 sha256 | `a6df934b36382b2edc72cd90`（**24 位前缀，不是全值**）；md5 `62b41ed28673b7e5f32351403632538b`；70M |
| 是否部署 | **否。** 未 scp、未换二进制、未重启任何 unit |
| 生产未变证据 | `voice-worker-rust.service` MainPID **2017631**、ActiveEnter `2026-09-06 23:49:55 UTC`、`NRestarts=0` —— 与 B31 同值 |
| 灰度现状 | `voice-worker-firstturn.service` MainPID 2612447 仍跑**旧**二进制 `637a77fd…`，未替换 |

⚠️ **一个必须说清的构建链细节**：home-studio 构建树对 origin 无凭据，`git fetch` 失败，所以二进制**不是从「checkout 该提交」建出来的**，而是从与提交 blob **逐字节对撞过**的文件建的。对撞值：`pipeline.rs` = `e3a8b952eeaef23cc2ef413d04d257ae`、`eot_snapshot.rs` = `b8a45f3c8c3c7484400319a2a277761c`，两边（`git show 5dff4583a:<path>` 与构建树文件）完全相同。**不冒称是提交检出物。**

### 负向验证（三处，每处先确认注入落地再判）

| 注入的真 bug | 注入落地 | 测试 |
|---|---|---|
| 去掉 `timed out` 分支 | ✅ diff 非空 | 2 红 |
| 配额 `>=` 改 `>` | ✅ diff 非空 | 2 红 |
| 去掉同帧合并守卫 | ✅ diff 非空 | 1 红 |

**第二条第一次跑是全绿的，值得你知道为什么**：我原先把配额在 `request` 和 `take_pending` **两处各拦一道**，破坏任一处另一处都兜住 → 两处都测不出来。已改成**单一执行点**（`take_pending`），并把配额测试改成端到端不变量（跑满 10 轮只许落 3 段），这才有区分力。顺带记一句：我第一次判「测试漏了」时其实还没验证注入有没有落地——注入失败和测试抓不住产生的是同一个绿，这一步不能省。

## 3. A：ready 发送结果日志格式（§6 第 2 项）

成功：
```text
INFO control publish result room=<room> event=session.input_ready trace=<trace> since_job_ms=<n> send_ms=<n> publish_ok=true
```
失败：
```text
WARN control publish result room=<room> event=session.input_ready trace=<trace> since_job_ms=<n> send_ms=<n> publish_ok=false fail_class=<not_connected|timeout|payload|closed|other>
```
旧行改标 `session.input_ready published(scheduled)`，兼容保留。

按你的要求逐条对齐：

- **保留原发射点、同 job 最多一次、trace/room 绑定、payload 语义**：全部未动，只把发送结果记下来。
- **不重发**：整个函数只有一次 `publish_data`，无重试循环。
- **不阻塞 PCM 管线**：仍在 `tokio::spawn` 内 await，判决/输入热路径不等它。
- **`publish_ok=true` 只表示 SDK 发送调用成功，不等于 Android 消费 ACK**——照你原话的口径，日志里也没有任何「已送达」措辞。
- **不打印 JWT / 房名 / 错误链 URL 与 query**：失败只记**枚举类别**。LiveKit 的错误链里可能带信令 URL，而 token 就在 query 里，整条打进 journal 等于把凭据落盘。测试 `fail_class_never_leaks_url_token_or_room` 断言的是**脏值的缺席**（拿一条含 `wss://…?access_token=eyJ…&room=sn-…` 的错误串跑，断言返回值里不含 `eyJ`/`wss://`/`access_token`/`sn-`），不是断言「脱敏动作发生过」——后者永远会绿。
- **本轮不在 RTC phase 重发 ready**：没做，等新证据。

## 4. B：打断取证快照（§6 第 2 项）

### 开关与配额

| 项 | 值 |
|---|---|
| 主开关 | `INTERRUPT_SNAPSHOT_ENABLED`，**未设或非 `1` = 关**（默认关） |
| 每房上限 | `INTERRUPT_SNAPSHOT_MAX_PER_ROOM`，默认 **3** |
| 前置 | 还需 `EOT_SNAPSHOT_DIR` 已配（复用同一 sink 的目录、每 job 配额、全局字节上限） |
| 窗口 | 复用现有 `SNAP_WINDOW` = 8s @16k mono s16，**未加长** |

### 关闭时为什么不新增任何录音或文件

三道都在最前面，且都不是「判断后跳过」而是「对象根本不存在」：

1. `InterruptSnap::from_env()` 未开启 → `None`，字段为空。
2. `request_interrupt_snapshot` 第一行 `if self.isnap.is_none() || self.snap.is_none() { return; }` —— 不分配、不 format、不登记。
3. `drain_interrupt_snapshot` 第一行 `let Some(is) = self.isnap.as_mut() else { return };`。

**环容量完全没碰**：上行环长度仍由既有的 `SnapshotSink::ring_keep(snap.is_some(), …)` 决定，本轮一个字节都没改。测试 `disabled_by_default_yields_none` 守着默认关这条（并配了开启路径的正锚，否则「永远 None」和「构造函数坏了」不可区分）。

### 触发点与事件关联

五个 ASR 判决点都登记，**被吞和被 commit 都能关联**：

| decision | reason 形态 | 对应判决 |
|---|---|---|
| `swallowed` | `local_audio_echo:<slot>` | 单字 / 文案库命中吞 |
| `swallowed` | `local_audio_echo_overlap:<slot>` | 开场重叠窗放宽门吞 |
| `swallowed` | `<kind>:<path>` | 停 / 退出 / 设备命令吞 |
| `swallowed` | `tts_echo_substring` | 近期 TTS 子串回声抑制 |
| `committed` | `eou:<n>ms` | 成为新轮（B31 里「是的」走的就是这条） |

`events.jsonl` 新事件 `ev=interrupt_snapshot`，字段：

```text
seq            对齐 wav 文件名 t{seq:04}.wav；配额到顶写 "capped"
decision       swallowed | committed
reason         见上表
playing        判决那一刻的播放来源
turn_id        当时的 turn
decide_ms      判决时刻（job 单调钟）
capture_ms     实际落盘时刻（同上）
ring_samples   本段样本数
```

**`playing` 的取值口径（你要求没证据就写 unknown，我照办）**：

- `worker_filler` / `worker_body`：由 `turn.filler_samples` 与 `ctl.played_samples()` 比较得出，是真值。
- `turn_no_audio_yet`：有 turn 但音频还没起播。
- `none`：当时没有在途 turn。
- `device_local_receipt_gate`：**只标门状态，不冒充「正在播本地承接」**——worker 只知道本地承接门还没放行，并不知道设备扬声器此刻是否真在响。这一条按你的要求没有猜。

### 不做的事

- **不每 interim 反复存盘**：同一帧内多次判决只留第一个（测试 `coalesces_multiple_requests_in_one_frame` 守着）。
- **不阻塞热路径**：判决点只登记意图、零 IO；真正落盘在输入环下一帧（≤20ms，8s 窗内容等价），wav 写入沿用 `SnapshotSink::snapshot` 内部的 `spawn_blocking`。
- **未改**回声门、VAD 阈值、AEC、音量、短词吞句、命令词优先级、追补环（仍 0）、PCM 协议、receipt/phase 合同、灰度名单、Session API 签发。
- **不是新增音频采集**：复用既有上行环，没有新开采集通道。

## 5. 装机与清理计划（等你定窗口）

1. `scp` 新二进制到 64.90 的 `/root/voice-rust-worker.new`；**只换灰度 unit `voice-worker-firstturn`**，生产 `voice-worker-rust` 不碰。
2. 先备份现役 `637a77fd…` 二进制再换。
3. **重启窗口由你指定**（你 §4：不要在用户可能说话时重启）。我不自选时刻。
4. **装机时不开诊断**：`INTERRUPT_SNAPSHOT_ENABLED` 不写进 env 文件，保持默认关；人验那一轮再单独开、完事即关。**部署不自动开启采集。**
5. **权限**：给 unit 加 `UMask=0077`（新目录 700 / 新文件 600），并把现有快照树 `chmod 700/600` 补齐。现状是 755/644、`UMask=0022`，不满足你的要求。目录在 `/root` 下、不在 Git 内。
6. **清理**：测试完 `rm -rf` 当轮 job 目录；**最迟 24 小时内清空 wav**。长期回放要另行确认，我不擅自留样本。
7. **回滚**：停 unit → 换回旧二进制 → 起；诊断关闭 = 删掉那个 env 键。旧二进制与旧 unit 配置全程保留。

## 6. C：turn-2 约 1.1 秒空档拆解（§3C / §6 第 3 项）

trace `1267264e…`，全部取自**已有日志**，未重跑。服务端钟：

| 节点 | 时刻 | 距 commit |
|---|---|---|
| turn commit「是的」 | 10:05:12.020 | 0 |
| filler picked（barge，960ms） | 10:05:12.020 | +0ms |
| filler 起播 | 10:05:12.054 | +34ms |
| **filler 播完** | 10:05:13.020 | **+1000ms** |
| **LLM 首 token（race 判定）** | 10:05:13.324 | **+1304ms** |
| TTS synth 请求（**整段 85 字**） | 10:05:13.739 | +1718ms |
| LLM 流结束 | 10:05:13.745 | +1725ms |
| **正文首帧** | 10:05:14.119 | **+2099ms** |

**1100ms 空档的构成**：

- **304ms**：filler 已播完，**LLM 首 token 还没到**（13.020 → 13.324）
- **415ms**：首 token → TTS 请求发出（13.324 → 13.739）
- **380ms**：TTS 请求 → 首 PCM（13.739 → 14.119）

**你问「是否是垫句结束后仍等正文」**：是在等，但**不是可以靠并行化消除的空转**——根因是 **filler 只有 960ms，而生成链需要 2099ms，差 1139ms**，与观测到的 1100ms 空档和 `underrun_ms=1093` 三者同量级。

**你问「当前是否已并行 TTS」**：**turn-1 并行了，turn-2 没有。**

- turn-1：`tts first clause split (comma, before sentence end) turn_id=1 chars=25 first_clause_min=4` —— TTS 拿到 25 字就开工，LLM 还在流。
- turn-2：**全窗口无 first clause split**，`tts synth` 一次收 **85 字**，且发出时刻（13.739）只比 `llm stream done`（13.745）早 **7ms** —— 等于等完了整段才合成。

这是个具体可改的点，但按你「先给事实、不通过拉长/缩短本地音频掩盖问题」的要求，**本轮不改**，也不加客户端缓冲盖静默。为什么 turn-2 没走切分，我**没有查发射条件，标未知**。

### 缺测项（明确标出，不拿别的数字顶替）

1. **TTS 连接就绪**：当前没有独立埋点，只有 `tts synth`（已带文本与字数）。你要的「TTS 请求/连接就绪」这一栏**缺测**。
2. **`body first sentence ready`**：房①两轮都有（`ttfb_ms=287/296`），**房②两轮都没有**。我未查它的发射条件，**标缺测，不猜**。这条恰好就是能把上面那 415ms 再拆开的埋点。

## 7. 对 B32 §1 你几条纠偏的回应

- 「Worker 早发 1.25 秒不能直接推出必丢」「`published` 在 spawn 后，尚非 publish_data 成功或设备接收确认」——**接受，这一条你是对的**，B31 我写「发得太早」时把「排队时刻」当成了「发送时刻」。本轮 A 就是为此补的分层事实，且我**没有**顺手加重发或改发射时点。
- 「单字『好』被规则吞，不能再拿分类标签证明真实回声」——接受。B31 我已标未知，本轮不追加任何推断。
- 「Android underrun=0 只计回调间隔，与 Worker 的 1093ms PCM 缺口可并存」——接受，撤回 B31 §6 把它当口径矛盾的写法，两者不是同一个量。
- 「先静音/关麦并行 cancel 是主动退出预期」——接受，撤回 B31 §6 第 2 条的疑问。

## 8. 本轮做了什么 / 没做什么

做了：改 2 个 worker 源文件、跑 265 测试、三处负向验证、构建并过符号门禁、推分支、只读查 64.90 的权限现状。

没做：**未部署任何二进制**、未重启任何 unit、未改 env、未铸房、未开采集、未动生产 `voice-worker-rust`(2017631) 与 Session API 签发、未动灰度名单、未改 AEC/音量/VAD/回声门/短词门/命令词优先级、追补环仍 0。

状态：**代码就绪，整体仍 DEGRADED**，等你定装机窗口。

署名：cc（Claude）| 2026-09-12 11:16 CST
