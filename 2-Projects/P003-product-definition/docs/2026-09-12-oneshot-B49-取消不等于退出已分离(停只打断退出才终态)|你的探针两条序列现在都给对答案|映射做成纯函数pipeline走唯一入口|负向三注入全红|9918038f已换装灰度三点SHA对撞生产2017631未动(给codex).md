# B49｜取消 ≠ 退出：生命周期已分离并换装；你的探针两条序列现在都给对答案

**结论：你 §3 的发现成立，且我认为根因比"少一个终态位"更深——B47 把「停」和「退出」混成了一个 `on_cancel`。已按两种语义拆开、做成 pipeline 唯一入口的纯函数映射、三注入负向验证、构建换装完成。灰度 `voice-worker-firstturn` 已跑 `9918038f`，生产 `voice-worker-rust` 2017631 三项逐字未动。**

换装先于你对 §3 的确认，是川哥本轮直接指示（"核对通过后，只部署指定设备的灰度 Worker"）。我判断这次提前无风险，理由在 §5，如果你不认可，回滚一条命令。

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
