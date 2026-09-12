# B49｜①三次实机根因已定界（两次异常是两个不同的洞）②120 秒等待的答案 ③取消≠退出已分离并换装

**先说最要紧的一件事：你报的这三次跑的不是我这版二进制。** 三房都在 06:19–06:20 UTC，我换装是 06:27:42 UTC——它们跑的是 B37 的 `4ba3b3a8…`（PID 2695094）。所以下面的根因与我本轮的生命周期改动无关，也不是 ready 补确认（它当时既没部署也默认关）。

**两次异常不是同一个故障，是两个机制不同的洞，而且都在 worker 侧、都能用日志坐实：**

| | 第二次 `8eb04bca` | 第三次 `14d51af0` |
|---|---|---|
| 打断者 | `停`，**以 interim 身份**命中急停白名单 | `雨洁`，走完整 final 路径 |
| 为什么没被回声门拦 | **急停白名单在 interim 层，排在所有回声门之前**——它根本走不到门那儿 | **TTS 回声门是「精确子串」判据**，`雨洁` 不是 `雨琪，今天方舟外头` 的子串 |
| 后果 | 正文 `Aborted`，只播了 208 帧 | 正文 `Aborted` → 起新轮 → barge 垫句「得嘞！」→「雨琪，我在呢。」＝**自问自答** |

第一次 `6973967b` 用户说正常，日志也正常：唯一那条一字 final `好` 被单字回声门吞了，正文 `SourceDrained` 自然播完。**所以"出现一字 final"确实不是故障判据，你这条判断对。**

**120 秒等待那次（`83f57014`，在生产 worker 上）答案很干净**：单字 `吧` 被单字回声门吞掉，零 commit / 零 LLM / 零 TTS。但 **worker 在吞它之前已经把这条 final 字幕发给端侧了**——wire 上「用户说了 X」发了，「这句不算数」一个字没发。端侧等 120 秒是合理反应，不是端侧的 bug。

以下全部只读取证，未部署、未改词表/AEC/生产/采集开关。

---

---

## 1. 认账：你测的不是边角，是我把两件事写成了一件

你的探针序列我复现了，结论一致：

```text
on_real_ready → on_cancel → on_request(7) = Restated      ← 应该是 Closed（如果那是"退出"）
on_cancel → on_request(8) = Pending → on_real_ready = Some(8)   ← 同上
```

但我不同意"加个 terminal 位"就算修完。B47 的 `on_cancel` 同时承接了两种完全不同的事：

- **停 / 插话**：用户只是打断在说的那句，会话和输入管线都还活着。此时补确认能力必须原封不动——你 §3 明确点了"不得修改「停只打断，不聊了才关房」的产品语义"。
- **退出 / 真实会话终止**：终态。迟到的查询不能再登记 pending，也不能重述。

一刀切置终态 = 损坏产品语义（你警告的那条）；一刀切不置终态 = 你测到的这个洞。**这两个错误方向相反，所以它不是一个布尔开关的问题，是入口没分类。**

## 2. 改法：两个方法 + 一张单测锁死的映射表，pipeline 走唯一入口

### 2.1 状态机（`src/ready_confirm.rs`）

| API | 语义 | 对 pending / 快照 / 预算 |
|---|---|---|
| `on_interrupt()` :117 | 停、插话 | **全保留**，什么都不动 |
| `on_session_exit()` :122 | 退出、真实会话终止 | `closed=true` + pending 作废；**幂等、不可逆** |
| `apply(Lifecycle)` :129 | 唯一分派入口 | 按上表 |

新判决 `Decision::Closed` :40。判定序是 **开关 → 终态 → 预算 → 快照 → pending**：终态排在预算之前，日志读者才能分清"会话没了"和"会话还在、只是已经答过了"——两者都不回复，混成一个枚举就没法排障。

终态后 `on_real_ready` 也**不再记快照**：否则一个已关闭的会话手里还攥着一份可重述的就绪状态，语义上说不通。

### 2.2 映射表是纯函数，而且是生产真的在调的那张

```rust
pub fn swallow_lifecycle(kind: &str) -> Option<Lifecycle>   // :149
//   "stop_only"    → Interrupt      「停」只打断
//   "session_exit" → Exit           「不聊了」才关房
//   其它 / 未知     → None           不动生命周期（将来加吞句类型必须显式归类才生效）

pub fn cancel_lifecycle(terminated_exit_signal: bool) -> Lifecycle   // :161
//   false → Interrupt   ← 默认。**绝不把所有 cancel 置终态**
//   true  → Exit        ← 唯一例外，见 §3.2
```

我特意没把这两个判断内联进 pipeline：内联的话单测只能测一个影子副本，改坏了生产测试照样绿。现在**单测锁死的那张表就是生产用的那张表**，改映射会同时翻红。

## 3. 你要的"实际 Cancel/SESSION_EXIT 入口如何映射"——两处，都在部署提交里

### 3.1 吞句判定（`pipeline.rs:2950-2951`）

```rust
if let Some(lc) = crate::ready_confirm::swallow_lifecycle(kind) {
    self.ready_confirm.apply(lc);
}
```

位置：`{kind} utterance swallowed` 那条日志的正下方。worker 侧 `kind` 只有两种（`pipeline.rs:2919-2939`）：
- `stop_only` = 整句就是急停词 → **Interrupt**
- `session_exit` = 退出词 exact / 复合句 tail / 碎片 fragment 三路 → **Exit**

⚠️ **终态判定不受 `exit_signal_on`（`SESSION_EXIT_SIGNAL_ENABLED` + canary SN）门控**。吞句面即判定面；信令发不发是另一回事。理由：worker 已经判定用户要退出并硬停了在播的 turn，此刻它对这个会话的认知就是"结束了"。让 canary 开关去左右终态，会造出"同一句话在两台设备上语义不同"的洞。

### 3.2 Cancel 包（`pipeline.rs:2400`）

```rust
let terminated_exit_signal = self.exit_pending.take().is_some();
...
self.ready_confirm.apply(crate::ready_confirm::cancel_lifecycle(terminated_exit_signal));
```

`Inbound::Cancel` **不带原因字段**，worker 无法从包本身分辨"停"和"退出"。唯一可靠判据是：它有没有终结一条在途的退出信令——按 v140 §4.3，Android 本地 exact 命中时会先发 cancel 充当退出终态。所以：

- 普通 cancel（`exit_pending` 为空）→ **Interrupt**。这是默认路径，覆盖你担心的"停了还能接着聊"。
- 终结了在途退出信令的那一发 → **Exit**。这一发通常在 §3.1 已经置过终态了，幂等无副作用；显式写出来是为了让映射可测、不依赖"另一条路径碰巧先跑过"。

### 3.3 结构性保证（你问"如上层已有保证请给路由证据"）

`ctrl_rx` 归 `run_pipeline` 所有（`job.rs:146/345`）；pipeline 退出即 receiver drop，`ctrl_tx.try_send` 直接失败。**job 关闭之后的包根本到不了状态机**——这一段确实有上层保证，不需要终态门。

需要终态门的是**另一个窗口**：从 worker 判定退出，到房间真的关掉之间（退出信令 ACK 预算 750ms + 800ms×3 重试，最长约 2.4s+）。这个窗口里迟到的 query 完全可能到达，而上层什么都挡不住。所以门加在这里，不是加在 job 生命周期上。

## 4. 验证

### 4.1 你的两条探针序列，现在两种口径都给对答案

| 序列 | 当「停」 | 当「退出」 | 测试 |
|---|---|---|---|
| ready → 事件 → request(7) | `Restated` | `Closed` | `interrupt_after_ready_still_restates` / `session_exit_after_ready_closes_late_request` |
| 事件 → request(8) → ready | `Pending` → `Some(8)` | `Closed` → `None` | `interrupt_keeps_pending_and_ready_fulfils_it` / `session_exit_before_ready_never_pends_nor_replies` |

左列正是你探针跑出来的值——它们本身没错，错的是 B47 把这两列合成了一列。

`ready_confirm` 测试 **5 → 16**（退出 4 条 / 停 4 条 / 映射矩阵 3 条 / 原 5 条）：

```
session_exit_after_ready_closes_late_request        session_exit_before_ready_never_pends_nor_replies
pending_then_session_exit_then_ready_does_not_reply  session_exit_is_idempotent_and_irreversible
interrupt_after_ready_still_restates                 interrupt_keeps_pending_and_ready_fulfils_it
interrupt_before_anything_still_pends                repeated_interrupts_do_not_touch_budget
closed_takes_precedence_over_budget_exhausted        swallow_lifecycle_matrix
cancel_lifecycle_matrix                              apply_routes_stop_and_exit_differently
disabled_never_restates_or_pends                     ready_first_then_request_restates_once
request_first_then_ready_fulfils_pending_with_seq    snapshot_is_the_original_timings
```

Worker 全量 **274 → 285，0 失败**（Air / rustc 1.94.1 与 构建机 / rustc 1.98.0 两套工具链各跑一遍，均 285）。`cargo clippy --all-targets` RC=0，`ready_confirm.rs` 告警 0（全量 17 条历史告警仍在，证明这个 grep 有信号能力，不是空扫）。

### 4.2 负向验证：三个注入，**每个都先确认 diff 落地再跑测试**

| 注入 | 变红 |
|---|---|
| ① `cancel_lifecycle` 恒返回 `Exit`（= 你警告的"所有 cancel 都置 terminal"） | 2 条 |
| ② `swallow_lifecycle("session_exit")` 返回 `Interrupt`（退出不关会话） | 2 条 |
| ③ 删掉 `on_request` 的终态判定（= B47 原缺陷，复刻你的探针场景） | 5 条 |

三次注入 diff 行数分别 2/2/3，非空；恢复后与注入前逐字节一致，285 全绿。

### 4.3 §3 末段的措辞我改了

`control.rs` 原注释写"与首次发射同一构造，只在 payload 追加 request_seq"——确实会被读成整包字节相同。已改成你要的精确口径：**同构造、同输入就绪语义，`timings` 保持首次发射的原值；`ts_ms` 是重述时刻、`output_ready` 是重述时的真实值；payload 追加 `request_seq`。不是整包字节与首次完全相同。** 这条精确表述在部署提交的 `ready_confirm.rs` 模块头里已经有；`control.rs` 的那行是随后单独一个 docs commit（见 §6 锚），**不在已部署的二进制里**，零行为差异。

## 5. 换装：已完成，只动灰度

| 项 | 值 |
|---|---|
| 部署提交 | `9918038f408b1649f9800d5430d69e587a4a91f6` |
| 二进制 SHA256 | `241585162416cfcde4d0d7d632b477a7fa29d1d6e6e70326cc263b6e5bb90fef` |
| 三点对撞 | 构建机 / Air 中转 / 64.90 落地，三处逐字相同 |
| 灰度 MainPID | 2695094 → **2714944**，ActiveEnter 2026-09-12 06:27:42 UTC，NRestarts 0 |
| 运行中 exe | 读 `/proc/2714944/exe` 校验 = 上面那个 SHA（不是读配置文件） |
| 上一版 | `/root/rust-worker-firstturn/voice-rust-worker.prev` = `4ba3b3a8…`（B37），另存 `/root/b48-backup/` 含二进制+env+unit |

空闲判定：换装前两次核对 `received job request`=10 == `job closed`=10 == `process exiting`=10；窗口内 1899 行日志作正锚（证明不是"grep 不到所以以为空闲"）。

**开关只进灰度专属 env**：`/root/rust-worker-firstturn/rust-worker-firstturn.env` 加 `ONESHOT_READY_CONFIRM_ENABLED=1`，键数 13→14。三个共享文件 `.env` / `poc-eou.env` / `rust-worker.env` 命中均 0，且三者各自键数 37/11/41 非零作正锚。

进程环境实测（读 `/proc/2714944/environ`，只查键不打值）：

| 键 | 命中 | 期望 |
|---|---:|---|
| `ONESHOT_READY_CONFIRM_ENABLED=1` | 1 | 1 |
| `EOT_SNAPSHOT_DIR` | 0 | 0（真 unset，靠 unit `UnsetEnvironment=`，不是置空） |
| `INTERRUPT_SNAPSHOT_ENABLED` | 0 | 0 |
| `AGENT_NAME` | 1 | **正锚**，证明上面两个 0 不是因为读不到 environ |

`Umask: 0077`；`registered worker` 1 次；`journalctl -p err \| grep -c voice-rust-worker` = 0（配 690 行 info 正锚）；WorkingDirectory 下 `2026*` 目录 **0 个**，无新增采集文件。

**生产与另两个 unit 逐字未动**：`voice-worker-rust` MainPID 2017631 / ActiveEnter 2026-09-06 23:49:55 UTC / NRestarts 0，与动前快照三项完全相同，exe SHA 前缀 `f3707e7eae7e3a42…` 未变；`voice-worker-colleague` 1478161、`voice-console` 1478159，NRestarts 均 0。Session API、灰度名单未碰。

### 为什么我判断提前换装无风险

新协议路径**在 v266 装机前是死的**：`control::parse` 只认 `session.input_ready.request` 这个精确类型串，v265 不发它，状态机拿不到任何请求。而 Cancel 那条改动在没有请求的情况下同样无效——`Interrupt` 是空操作，`Exit` 只置一个仅供 `on_request` 读的位。

`on_real_ready` 里新增的终态判断也够不着：`input_ready` 在**首个 mic 帧**触发，而退出判定必须先有 ASR final，ASR final 必然晚于首个 mic 帧。所以"先退出后 ready"在真实时序上结构性不可能。

回滚（零编译）：`install -m 755 /root/rust-worker-firstturn/voice-rust-worker.prev …/voice-rust-worker && systemctl restart voice-worker-firstturn`，或只删 env 那一行 restart（退回默认关）。

### 5.1 换装后 30 分钟内已跑过 4 个真实房间（不是静态部署）

写这份回执时灰度已自然接到 4 个 job（指定设备在用）。新二进制的真机实测：

| 项 | 值 |
|---|---|
| `received job request` / `job closed` / `process exiting` / `input_loop_started` | 4 / 4 / 4 / 4，全部对齐 |
| `session.input_ready published(scheduled)` | 4 |
| `publish_ok=true` / `publish_ok=false` | **4 / 0** |
| `control cancel` | **3** ← 本轮改动的 Cancel 分支真机触发了 3 次 |
| `input_ready.request` / `restated` | 0 / 0 ← by design：v265 不发请求，不是故障 |
| `panic` / `pipeline exited with error` / `NRestarts` | 0 / 0 / 0 |

**`cancel_lifecycle` 这条新分支已经在真房里执行过 3 次**（`session_exit signal`=0，所以 3 次都走 `terminated_exit_signal=false` → `Interrupt`），会话正常收尾、无 panic、无重启。这是我要的那个证据：单测全绿 + 构建通过 + 健康检查绿，加起来也证明不了新分支能跑，只有真被执行过才算。

⚠️ **诚实边界：`swallow_lifecycle` 那条分支这 4 个房里一次都没触发**（`utterance swallowed`=0，没人说"停"或"退出"）。它目前只有单测覆盖，**没有真机样本**。C 轮人验会覆盖到它，在那之前这条分支按"未真机验证"计。

## A. 三次实机：同 trace 服务端对账

运行锚：全部 `voice-worker-firstturn` / PID 2695094 / 二进制 `4ba3b3a8…`（B37），**换装前**。三房 `session.input_ready` 均 `publish_ok=true`（`scheduled_at_job_ms` 0/2/8，`send_ms` 全 0），端侧仍未观测到——与 B39/B41/B44 的交付段结论一致，本轮无新变化。

| 项 | ①`6973967b` 正常 | ②`8eb04bca` 异常 | ③`14d51af0` 异常 |
|---|---|---|---|
| 首句 ASR | `小可小可我想听故事`（9 字） | `小可小可说个长句测试一下吧`（13 字） | `小可说个长句测试一下`（10 字） |
| 首句完整性 | **完整**，唤醒词两个「小可」都在 | **完整** | ⚠️ **唤醒词只剩一个「小可」**（见 §C） |
| 历史 samples | 32000 | 32000 | 10720 |
| commit / outcome | task，`eou_ms=45` | task，`eou_ms=36` | task，`eou_ms=20` |
| 首轮垫句 | `filler skipped: device local receipt` → `body first frame (no filler)` | 同左 | 同左 |
| LLM | ttft 1334ms / 27 字 | ttft 798ms / 47 字 | ttft 1332ms / 73 字 |
| 首轮播出终态 | **`SourceDrained`**（自然播完，652 帧） | **`Aborted`**（208 帧） | **`Aborted`**（259 帧） |
| 短句命运 | `好`→单字门吞 | `好`→单字门吞；**`停`→急停白名单打断**；`鞋`→单字门吞 | `略`→单字门吞；**`雨洁`→穿过全部门，commit 起新轮** |
| 新增轮次 | 0 | 0（只打断不起轮） | **1**（turn 2，barge 垫句「得嘞！」+「雨琪，我在呢。」） |
| Worker underrun | 0 | 0 | turn2 = **1 次 36ms** |
| 上行 10s 均幅 `mean_amp` | **25** | **48** | **44** |
| 退出 | `退出` exact 吞句 → 信令 → cancel 终结 | 同左 | 同左 |

三房的 `control cancel` 都是 `cancelled=false had_turn=false`——**退出时并没有在播的 turn**，所以退出本身没打断任何东西，异常发生在更早。三房都 `room deleted` + `job closed`，服务端**确认真实收口**（你问的第 4 点）。

## B. 两个洞的精确机制（都在 worker 侧，可复核）

### B.1 第二次：急停白名单在 interim 层，排在所有回声门之前

`pipeline.rs` 里 `check_hotword()` 被**两处**调用：`on_interim()` 和 `on_final()`。它的逻辑是「agent 正在出声 + 标准化后精确命中急停词 → **绕字数门硬打断**」。

灰度生效的词表来自 `/root/rust-worker/rust-worker.env`（生产共享文件，灰度层叠到）：

```
INTERRUPT_HOTWORDS=停,停止,停停,停下,停一下,等等,等一下
```

日志坐实：06:20:18 `急停白名单命中: '停' → interrupt`，紧接 `agent turn aborted`、`interrupt telemetry: speaking→listening interim='停'`。**注意 `interim='停'`——journal 里全程没有 `stt final: 停`。** 这条「停」从来没成为 final，所以：

- 它没进过任何回声门（回声门全在 final 处理链上）；
- 端侧也拿不到它的 local final——这正好解释你看到的 13/1/1/2 里为什么没有「停」。

⚠️ 顺带自曝一处**代码注释与实际行为不一致**：单字回声门的注释写着「开场窗内单字 commit 一律吞…**急停单字在此被吞与 stop_only 效果等价**」。这句只对 final 路径成立。interim 路径先到、先 abort，那扇门根本没机会开。两条路径对同一个「停」判定相反，先到的赢。

### B.2 第三次：TTS 回声门是精确子串，对 ASR 错转结构性无效

`雨洁` 走的是完整 final 路径，逐门过了三道：

| 门 | 判据 | 为什么没拦住 |
|---|---|---|
| 单字本地回声门 | `n_chars == 1` | `雨洁` 是 2 字 |
| 本地音频回声库 | 2–3 字精确子串 / ≥4 字 LCS，**比对的是设备本地回复库（15 条）** | `雨洁` 不在本地回复库里——小可是**云端 TTS** 说的，不是本地音频 |
| TTS 回声对撞门 | `≥2 字` 且 `normalize(近期播出文本).contains(normalize(用户文本))` | **`雨洁` 不是 `雨琪，今天方舟外头` 的子串**（琪≠洁） |

当时 `agent turn aborted ... synth_chars=19 spoken_chars=9`——小可已经说出口的正是 `雨琪，今天方舟外头`。**小可每一轮回复都以「雨琪，」开头**（第一次 `雨琪，想听什么故事呀？`、第二次 `雨琪，今天方舟窗外…`、第三次 `雨琪，今天方舟外头…`、新轮 `雨琪，我在呢。`）。

**这个洞代码自己早就知道**：单字门的注释写着「`来啦` 被 ASR 错转成 `那`（la→na）——**子串判定对错转结构性无效**」，当时的补丁是「开场窗内**单字**一律吞」。也就是说，已知漏洞只补了 `n=1`。**第三次是同一个漏洞的 `n=2` 实例。**

### B.3 声学来源：**我判不了，不下结论**

`雨洁` 究竟是回声还是孩子说话，日志层面无法区分——两者产生完全相同的 ASR final。我能给的只有三条旁证，都不足以定性：

1. 时间吻合：小可 06:20:31 开口说「雨琪，」，`雨洁` final 落在 06:20:33，约 2 秒——在 ASR 端到端延迟的合理范围内。
2. 字形接近但**不是同音**（yǔqí / yǔjié），所以「同音误识」这个说法我不用。
3. 上行均幅：正常那次 **25**，两次异常 **48 / 44**，接近两倍。但 `mean_amp` 是 10 秒窗内所有上行能量，**它把孩子的声音和任何回灌算在一起，本身分不开**，所以这只是线索不是证据。

**唯一能定性的是上行音频本体。灰度这两房没有**——B37 起 `EOT_SNAPSHOT_DIR` 已 `UnsetEnvironment`，我核过灰度进程环境该键命中 0。生产那房（`83f57014`）虽然采集开着、job 目录也建了，但**目录里 0 个文件**（快照只在判停路径落盘，那房从未 commit 过任何 turn，结构性不会落 WAV）。

所以：**想给「自打断」定性，只能开一次知情录音窗口**。这事我不自己决定，等你和川哥点头。

## C. 短历史（10720 样本 / 670ms）确实吃掉了唤醒词前半

你在 §2 自己预告过「短历史可能只保留唤醒词后半段」。第三次给了实据：

| | 历史 samples | ASR 首句 |
|---|---|---|
| 第二次（满缓存） | 32000 | `小可小可说个长句测试一下吧` |
| 第三次（短历史） | 10720 | `小可说个长句测试一下` |

两次话术几乎相同，**短历史那次开头少了一个「小可」**。提交链本身没坏（`outcome=task`、`eou_ms=20`、`ordered_pcm begin accepted`），`on_begin` 对 10720 样本照常受理——你说的「只证明重入和提交链打通」完全成立。

但这条实据把你那个担心变具体了：**320ms 门槛下唤醒词被截断是真实可能，不是理论风险。** 「传统只唤醒会不会误成 TASK」必须实测——如果截掉的恰好是唤醒词，剩下的残段反而更像一句任务。

## D. 120 秒等待（`83f57014`）：你问的四件事逐条回答

这房在**生产 worker**（`voice-worker-rust` / 2017631），不是灰度。

1. **那个单字的真实命运**：06:16:54 `stt final: 吧` → `local-audio echo suppressed (opening window): '吧' slot=single-char` → **吞掉**。零 `UserTurnCommitted`、零 LLM、零 TTS。这是**设计行为**：开场 15 秒窗内单字一律判回声（`LOCAL_AUDIO_ECHO_WINDOW_MS` 未设，代码默认 15000）。
2. **后续上行与 ASR 管线是否继续**：**完全正常**。之后每 10 秒稳定 `audio in frames=1000~1005`，均幅 26→4→4→3→2→3→3→**68**→3→3，job 存活 104 秒直到用户按「不聊了」。ASR 未断（`asr ws closed by server` 出现在 job 关闭之后）。06:18:13 那个 68 的能量脉冲没产出 final。**不是管线死了，是它在正常地等一句没来的话。**
3. **已有何种完成/拒绝信号可被 Android 消费**：🔴 **零。** 我查了两条可能的通道，都不成立：
   - `契约 UserTranscriptFinal` / `UserTurnCommitted` 这套——`contract.rs` 全文只是 `info!` **日志**，**不发包**。「只有 Final 没有 Committed ＝ 这句没发生」这个语义只存在于服务端 journal，端侧看不见。
   - 字幕通道 `transcript_pub` ——它**真发**（LiveKit `Transcription`，`final=true`）。而且在 `on_final()` 里，`tr.user_final(&t)` 排在**吞句判定之前**，无条件先发。
   
   合起来就是这次故障的确切形状：**worker 对每条 ASR final 无条件宣告「用户说了 X」，然后才决定吞不吞；吞掉的那条在 wire 上没有任何撤回或终结。** 端侧把「收到 user final」读成「会有回复」，而这个蕴含关系 worker 从来没在协议上保证过。你的 `awaitResponse` 是在一个没有兑现承诺的信号上等。
4. **是否服务端死锁**：不是。`job rss` 稳定 329MB，watchdog 无告警，房间到用户主动退出才关。

你说端侧等待状态由 codex 修、不要求我先加协议——同意，我不动。但把选项摆一下，供你判断（三条都**未实施**）：

- **端侧独扛**：只能靠超时，区分不了「worker 在想」和「worker 吞了」，120 秒缩到多少都是猜。
- **worker 一行位置改动**：把 `tr.user_final()` 挪到吞句判定**之后**，被吞的句子不发 final 字幕。这样「收到 final」就真的蕴含「会有回复」，**零新协议零新字段**。代价是产品可见：用户说「退出」时不再显示「退出」字幕。
- **worker 加一条下行终结信号**：最干净，但要新协议，按你的要求本轮不做。

我倾向第二条，但它改的是产品可见行为，要你和川哥拍板，我不自己动。

## E. 我这轮没做、也不建议现在做的

- 不改 `INTERRUPT_HOTWORDS`、不改两个回声窗、不改 AEC/音量/704ms、不碰采集开关、不改生产。
- 不因为三次样本就去调急停白名单或回声门阈值——第二次的洞是**层级问题**（interim 绕门）不是阈值问题，调阈值治不了；第三次的洞是**判据形态问题**（子串 vs 错转）不是阈值问题，同理。
- 不把这次播报异常算到 ready 补确认头上——它当时既没部署也默认关，你这条边界我照办。


---

# 以下为本轮生命周期修复部分（B48 §3 的回答，与上面三次实机无关）

## 6. 锚

| 项 | 值 |
|---|---|
| 部署提交（= 二进制来源） | `9918038f408b1649f9800d5430d69e587a4a91f6` |
| 分支头（多一个 docs-only commit，**不在部署二进制里**） | `dc9545e3968df911df0ab9b522a593c0f540c254` |
| 分支 | `feat/ordered-pcm-input`，已 push origin |
| 变更文件 | `src/ready_confirm.rs`（+225/-18 含测试）、`src/pipeline.rs`（16 行）；docs commit 另动 `src/control.rs` 注释 |
| 未动 | ASR / LLM / TTS / VAD / 704ms 判停 / AEC / 音量 / STOP / EXIT / 首句提交路径 / ordered_pcm wire / 生产 worker / Session API / 灰度名单 |

## 7. 交回给你 / 还没做的

1. **你的 §2 首句重入候选（320ms 短历史）我这边零改动**——`ordered_pcm.rs` `on_begin` 不要求历史等于 32000 样本这点我复核过，确实不需要服务端配合。你提的"传统只唤醒会不会误成 TASK"我同意必须实测，那是端侧声学问题，我插不上手。
2. **两次人验分开做**，按你 §4：先测首句重入（补确认门可保持 0），再单独开补确认测 `query → restated → SDK → accepted`。worker 侧现在两种口径都就绪。
3. **C 轮（短答 / 停 / 退出）仍未做**。现在有了新判据：说"停"之后日志应能看到后续查询仍 `restated`；说"退出"之后应是 `closed`。这两条是同一次人验能顺手拿到的。
4. **知情录音窗口**未开（独占根 700/600 + 24h 定时清理），两条采集通道仍关。
5. underrun 口径差异（服务端 A 房那次 42ms vs 端侧 0）还没对账，不影响本轮。

整体仍 **DEGRADED**：ready 交付段的根因没找到，本轮做的是"丢了能补一次"，不是"不会丢"。

---

# 状态与下一步

| 项 | 状态 |
|---|---|
| 三次实机异常 | **根因已定界到两个具体机制**（B.1 interim 绕门 / B.2 子串判据对错转无效），均未修 |
| 声学来源（回声 vs 孩子） | **未知，且现有证据无法定性**；要定性只能开知情录音窗 |
| 120 秒等待 | **机制已查清**（D.3：字幕 final 先发、吞句后判、wire 上零终结信号），修法三选一待你与川哥拍板 |
| 短历史唤醒词截断 | **已有实据**（C 节），你的实测要求成立 |
| 取消≠退出生命周期 | **已修已换装**，灰度跑 `9918038f` |
| ready 交付段根因 | 仍未找到 |

我建议的顺序：先定 D 节那个三选一（它是唯一一个"用户明确报了、且我这边一行就能改"的），再决定要不要为 B.1/B.2 开录音窗取证。B.1 和 B.2 的修法我都有想法，但两个都会改变打断灵敏度，属于产品手感，**没有声学证据之前我不动**——上次我凭文本推声源的教训还热着。

署名：cc（Claude）| 2026-09-12 14:49 CST
