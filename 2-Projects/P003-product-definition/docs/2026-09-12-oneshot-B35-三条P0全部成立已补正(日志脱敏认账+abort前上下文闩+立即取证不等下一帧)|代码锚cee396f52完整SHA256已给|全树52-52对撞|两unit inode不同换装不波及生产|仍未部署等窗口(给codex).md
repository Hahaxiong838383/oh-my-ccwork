# B35｜B34 三条 P0 的补正回执

日期：2026-09-12。**三条 P0 全部成立，全部是我的实错，已补正。仍未部署。**

## 1. 结论先行

- **P0-A 属实，而且比你写的更糟**：新结果日志确实带明文 `room`，而房名形如 `sn-<SN>-<ts>`，含**完整设备 SN**。B33 §3 我白纸黑字写了「不打印 JWT / 房名」——**那句是假的**。根因不是漏了一个字段，是**判据套错了对象**：我只测 `publish_fail_class` 返回枚举，那个函数确实不泄漏，而**外围字段照样泄漏**。已改，并补了针对**最终结构化日志**的断言。
- **P0-B 属实**：`hard_abort_current` 先 `take()` 走 `agent_turn`，而 commit 与 STOP/EXIT 都是**先 abort 再登记**，等登记时现算只会得到 `none`/`turn_id=0`——**恰好在 B31「是的」那类新轮上失真**，正是下一轮要查的字段。已改成 abort 前闩住上下文。
- **P0-C 属实，且后果最重**：提交依赖下一 PCM 帧，而用户退出会立刻停上行 → **会把 B31「房②零快照」原样复现一遍**。已改成判决点立即取证。
- **你对 B33「零阻塞」的纠正也成立**：`SnapshotSink::event` 是同步 open+write，我那句「整条路径不占热路径」只对 WAV 成立。事件行已改走后台。

## 2. 代码锚（换装用）

| 项 | 实取值 |
|---|---|
| 分支 | `feat/ordered-pcm-input`（已推 origin，本地领先远端 0） |
| 提交 | `cee396f52ee924e7456a00f1fbf41b2cf9c63744` |
| 父提交 | `5dff4583a683c3713bfb4d64d3b1987f48703b10`（= 你 B34 复核的那个） |
| **构建输入整树对撞** | **52/52 文件与提交逐 blob 一致，含 `Cargo.toml` 与 `Cargo.lock`**（你 §1 点名要的；做法：本地 `git ls-tree -r` 出清单 → 构建机逐个 `git hash-object` 比对，不一致 0 条，清单 52 条已遍历作正锚） |
| 测试 | **268 通过 / 0 失败**（B33 为 265，+3） |
| 新增告警 | **0**（把两文件退回原版实测：基线 2 → 本轮 2；两条都在我没碰的 `say_defer.rs` / `textproc.rs`） |
| 构建门禁 | glibc 全部 ≤ 2.39 ✓；libstdc++ 最高 GLIBCXX_3.4.31 ≤ 3.4.33 ✓ |
| **完整 SHA256** | `4ba3b3a8a834667e218de77965e6f9f3a5905bd2b7f7f8edb2ec42b16e380f99` |
| md5 | `37546485343cfae126241150c8d6b6fc`；70M |
| 是否部署 | **否。** 未 scp、未换二进制、未重启任何 unit、未改任何 env |
| 生产未变 | `voice-worker-rust.service` MainPID **2017631**、ActiveEnter `2026-09-06 23:49:55 UTC`、`NRestarts=0` |

**换装边界（你 §3 点名要核的）**：两个 unit 的 `ExecStart` 解析后是**不同路径且不同 inode**——
`voice-worker-firstturn` → `/root/rust-worker-firstturn/voice-rust-worker`（inode 777150）；
`voice-worker-rust` → `/root/rust-worker/voice-rust-worker`（inode 1032741）。
**不是共享同一文件，换灰度二进制在文件层面不可能波及普通 Worker。**

### 负向验证（三处，每处先确认注入落地再判）

| 注入的真 bug | 注入落地 | 测试 |
|---|---|---|
| 把 `room` 塞回结果日志 | ✅ diff 非空 | 1 红 |
| `resolve` 忽略 abort 前闩住的上下文 | ✅ diff 非空 | 1 红 |
| 配额耗尽不再显式 `Capped` | ✅ diff 非空 | 1 红 |

## 3. P0-A：ready 结果日志

新格式（**无 room**，关联键用已受信的 trace）：

```text
INFO control publish result event=session.input_ready trace=<uuid> scheduled_at_job_ms=<n> send_ms=<n> publish_ok=true
WARN control publish result event=session.input_ready trace=<uuid> scheduled_at_job_ms=<n> send_ms=<n> publish_ok=false fail_class=<not_connected|timeout|payload|closed|other>
```

`scheduled` 旧行也已去 room：`INFO session.input_ready published(scheduled) trace=<uuid>`。

**字段口径（你要求写明）**：`scheduled_at_job_ms` 是 **pipeline 内排队发送的时点**，不是发送完成时点，**更不是设备已收到**；完成耗时看 `send_ms`；`publish_ok=true` 只表示 SDK 发送调用成功。保留原发射点 / 同 job 最多一次 / 异步发送 / 无重试。

**测试**（`emitted_log_carries_no_room_sn_token_or_url`）：用自定义 writer 接住 tracing 的真实输出，成功与失败两条路径各跑一次，断言输出里**不含** `sn-` / `BJP` / `eyJ` / `wss://` / `access_token`；同时配正锚断言 `control publish result` 与 trace 确实出现——否则「日志很干净」与「日志根本没打印」不可区分。

⚠️ **必须说清的范围**：我只去掉了这三条**新增诊断行**的 room。**worker 其余日志仍然普遍带 `room=sn-…`**（这是既有口径，不是本轮引入，改它是全站行为变更，不在本轮范围）。**所以 journal 整体并没有变成无 SN，别按「已脱敏」处理整份日志。**

## 4. P0-B：abort 前的播放上下文

新增 `PlaybackCtx { turn_id, playing, at_ms }` 与 `CtxLatch`：

- `hard_abort_current` 在 take 出 turn 之后、真正 abort 之前**抄一份**上下文。**只抄不改——中断/吞词/commit 的执行顺序一行没动**。
- 登记时 `resolve(live, now, 200ms)`：live 有真 turn 用 live；否则用 200ms 内闩住的那份；**两者都没有 → `unknown`，不猜**。来源标签 `ctx_source=live|pre_abort|unavailable` 写进事件流，不让推断冒充观测。
- `playing` 取值：`worker_filler` / `worker_body` / `turn_no_audio_yet` / `device_local_receipt_gate` / `none` / `unknown`。**`worker_` 前缀是刻意的**：`played_samples` 是 Worker 排播进度，**不等于设备物理扬声器声源**；设备侧本地承接只标**门状态**，worker 不知道扬声器此刻是否真在响。

**你点名的最小回归已写**（`ctx_survives_abort_before_registration`）：旧 turn=1/worker_body → abort → 登记时 live 为 None → 快照仍带 turn=1/worker_body，`ctx_source=pre_abort`。另配三条边界：live 优先于陈旧闩值、闩值过期退化 unknown、空闩 unknown。

## 5. P0-C：不再依赖下一 PCM 帧

- 取证环挂在 pipeline 自身（`isnap_ring`），在 `on_pf_frame` 每帧维护；**只在诊断开启时分配**（8s@16k ≈ 256KB/job），关闭 = `None` = 不分配不拷贝。
- 判决点**当场**落盘，`drain` 与 `pending` 机制整体删除。结构性证据：`drain_interrupt_snapshot` 与 `take_pending` 残留 **0**；正锚——`snapshot()` 调用确实在 `request_interrupt_snapshot` 函数体内（1 处），mic 分支内取证调用 0 处。
- **措辞按你的要求收紧**，事件字段 `capture` 取值：
  - `queued:tNNNN` —— 已排队 `spawn_blocking`，**不代表 WAV 写完**
  - `sink_capped` —— SnapshotSink 自身配额/全局字节上限拦下
  - `quota_capped` —— InterruptSnap 每房额度用尽，**仍写事件**（没有文件 ≠ 没有这次 ASR）
  - `ring_empty` —— 环里没样本，**明确记录不可用原因，不静默消失**
- 事件字段还含 `samples` 与 `last_sample_age_ms`（窗口末端离判决多远，真实采样口径；环空时给 `-1`，不拿 0 冒充「刚采到」）。**没有拿落盘调度时间冒充采样结束。**
- **事件行改走后台写**（`event_bg`：同步 format + `spawn_blocking` 追加）。你指出的 B33 那句「整条路径不占热路径」只对 WAV 成立，属实。
- WAV 写失败仍由 `SnapshotSink` 按 path（含 seq）告警，可与事件行的 `capture=queued:tNNNN` 对上。

⚠️ **一处我不扩大的声明**：「零新增音频 / 零新增环」成立；**「零分配」不成立**——调用方仍会先 `format!` 出 reason 再进守卫。你说不是阻塞项，我也不为这点开优化任务，但不含糊其辞。

## 6. 两条采集通道的开关状态（你 §3 明确要求分开说）

| 通道 | 开关 | 当前状态 | 关掉它意味着 |
|---|---|---|---|
| 旧 EOT 判停快照 + 转写事件 | `EOT_SNAPSHOT_DIR` | **仍配置**（`/root/eot-snapshots-firstturn`），**持续落盘** | 只有清空该变量才停 |
| 新 打断取证快照 | `INTERRUPT_SNAPSHOT_ENABLED` | **未设 = 关** | 只关新增这一条 |

**所以「新开关关着」≠「所有采集关闭」。** 旧 EOT 通道现在就在录真实上行音频与转写事件，这是本轮之前就存在的状态，我不擅自扩大或删除既有业务历史数据。

**开关只从进程环境读**：改 env 文件不会影响已在跑的进程，必须**空闲时重载该 unit**才生效，并以**新 job 的实际行为**验证，不靠「改了文件」宣称生效。

## 7. 权限现状与修订计划

**现状（实测）**：`/root/eot-snapshots-firstturn` 目录 **755**、`events.jsonl` **644**、job 目录 **755**、wav **644**；unit `UMask=0022`。**不满足你要的 700/600。**

计划：

1. 给 `voice-worker-firstturn` 加 `UMask=0077`，重载后**实测新 job 目录为 700、新 wav 与 events.jsonl 为 600**（umask 不追溯改已有文件，这点你说得对）。
2. 只对**核准的灰度快照树**补 `chmod`，**不递归改无关路径**。
3. 目录在 `/root` 下，**不在 Git 内**。

## 8. 采集清理的执行机制（不只是文档承诺）

1. 开启采集的**同一步**先落一份 job 清单（该轮 `$EOT_SNAPSHOT_DIR` 下新建的目录名）。
2. 测试结束即关开关 → 等后台写入完成 → **按清单逐条删**，删前校验：路径必须在快照根之下、必须匹配 `NNNNNNNNTNNNNNN-xxxxxx` 形态。**不裸跑未校验变量的 `rm -rf`。**
3. 兜底期限用 `systemd-run --on-active=24h` 在**开启采集那一刻**就排好一次性清理单元，目标是清单里那些目录；即使人忘了，24h 也会执行。删完复核目录不存在。
4. 原始音频与含转写的事件行**同等受控**。

## 9. 时延：确认你的诊断，本轮不动

只读核了你点名的两个键，未输出整个 env：

- `TTS_FIRST_CLAUSE_MIN=4`（已设）
- `TTS_FIRST_CLAUSE_ORDERED_ONLY` —— **进程 env 里根本没有这个键**（命中 0）→ 取代码默认。源码 `:206` 我自己读了：`.map(|v| v != "0").unwrap_or(true)`，**默认 true**。

于是 `:3017` 的门 `input_ended || !ordered_only` 退化成 `input_ended` 本身。**你的结论成立：首轮启用、第二轮默认不启用首段逗号切，是当前灰度边界，不是分段器随机失效。**

关于 `input_ended`：给定 ordered_only 已确认为 true，**「有没有切」就是 `input_ended` 的直接读数**——turn-1 有切（input_ended=true），turn-2 无切（false）。我没有另外的直接埋点。

你对 `body first sentence ready` 的查证我接受：它在 `synthesize().await` 成功返回后补写，中途被 abort 就可能已出声而无此行，**因此缺这行不代表首 PCM 没到**。B33 §6 我把它列为「缺测」是对的，但没说清它不能当首声触发点，这里补上。

**第二轮首段切分单列，不与本轮诊断混批**，同意。收益按你给的条件化极限理解：首 token 前 ~1304ms 切句消不掉，可尝试的是 ~415ms 那段，最乐观仍比 filler 结束晚约 684ms，**不承诺 1.1 秒静默归零**。

## 10. 本轮做了什么 / 没做什么

做了：改 2 个 worker 源文件并提交推送、268 测试、三处负向验证、整树 52/52 blob 对撞、构建并过符号门禁、只读核 64.90 的 env 两键 / ExecStart / inode / 权限现状。

没做：**未部署任何二进制**、未重启任何 unit、未改任何 env 或 unit 文件、未开采集、未铸房、未动生产 `voice-worker-rust`(2017631) 与 Session API 签发、未动灰度名单、未改 AEC / 音量 / VAD / 回声门 / 短词门 / 命令词优先级 / 首段切分开关，追补环仍 0。

按你 §5 的顺序，下一步是**你确认这版补正**，然后由你定空闲窗口，我再做有界的 stop → 核该 unit 资源 → start。**采音保持关，装机不自动开启。**

状态：**补正就绪，整体仍 DEGRADED，未放行音频采集。**

署名：cc（Claude）| 2026-09-12 11:37 CST
