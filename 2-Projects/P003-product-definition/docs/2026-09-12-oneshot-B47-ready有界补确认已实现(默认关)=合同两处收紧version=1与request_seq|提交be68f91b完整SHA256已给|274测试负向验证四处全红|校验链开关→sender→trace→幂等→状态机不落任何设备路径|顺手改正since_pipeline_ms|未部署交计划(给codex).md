# B47｜B46 ready 有界状态补确认：worker 侧已实现，默认关，未部署

日期：2026-09-12。**只交代码锚、开关建议、测试与部署计划。当前 B37 灰度 worker 未动，生产 worker / Session API 零变更，未铸房、未开采集。**

## 1. 结论先行

按你 §3 的 wire 与 §4 的五条职责实现完毕。**合同我做了两处收紧，请确认**（其余与你提议完全一致）：

1. **`payload.version` 必须等于 1**，否则 `rejected_version` 只记日志不回应。缺字段解析为 0（不因端侧少字段就丢包），但不接受。这样将来改 wire 时旧 worker 不会用旧语义回应新请求。
2. **重述包在 `payload` 追加 `request_seq`**（你 §3 说"可加"，我加了）。其余字段与首次 ready **逐字段相同**（单测锁死 `type/src/trace_id/timings_ms/input_loop_started` 与首发一致）——是重述，不是另一套 ready。

## 2. 代码锚（换装用）

| 项 | 实取值 |
|---|---|
| 分支 / 提交 | `feat/ordered-pcm-input` @ `be68f91b4e8369aa57c2d2cbe10e83e38a6510ce`（父 `cee396f52…`，即 B37 在跑的那版） |
| 已推 origin | 是，推后复核本地领先远端 0 |
| 改动面 | 4 文件：新增 `src/ready_confirm.rs`；`main.rs`（注册模块）、`control.rs`（入站类型/解析/重述构造/测试）、`pipeline.rs`（cfg 开关、orch 状态、发射点接入、on_control 分支、时基改名） |
| 整树对撞 | **53/53 文件与提交逐 blob 一致**（含 Cargo.toml/lock；清单 53 条已遍历作正锚） |
| 测试 | **274 通过 / 0 失败**（B37 版 268，+6） |
| 告警 | 与 cee396f52 基线**完全相同**：2 条，`say_defer.rs:30` / `textproc.rs:151`（位置逐一核对，非只比计数） |
| 构建门禁 | glibc ≤2.39 ✓、libstdc++ ≤3.4.33 ✓；门禁自身的负向自检（喂 2.43/3.4.99 变红）也跑了 |
| **完整 SHA256** | `11d3b82220f0126af6e3fed8ee0241be2d0ac2df087d6048efb646acc8083685` |
| md5 / 大小 | `249d91505694c24f1d875ee6813963ae` / 72,486,064 B |
| 是否部署 | **否** |

⚠️ 中途抓到并已修的一条：首版多了两个无调用点的项（`from_env`/`enabled`），告警 2→3。已删——**开关只在 `PipelineConfig` 一处读 env**，模块内不再读；同一开关两处读会分叉（B44 坑一同族）。

## 3. 你 §4 五条职责的落点

| §4 | 实现 |
|---|---|
| ①识别+校验，不落设备路径 | `on_control` 新增独立分支 `Inbound::InputReadyRequest`。校验链 **开关 → sender → trace → 幂等 → 状态机**。sender 用现成的 `ordered_pcm::expected_device_identity(room)`（job.rs:237 信任 ordered 通道用的同一函数），trace 比对 `device_trace`，幂等用现成 `ctrl_dedup(trace,seq)`。**任何一环不过只记枚举，不回应。** 结构性 grep 锁死：该分支内 `start_turn/start_device_command/hard_abort_current/apply_ordered_actions/on_canary_say` 出现 **0 次**；`InputReadyRequest` 全仓只在 control.rs(枚举/解析/测试) 与 pipeline.rs(此分支) 出现 |
| ②真实就绪才重述 | 状态机只在 `on_real_ready` 记过快照后才 `Restated`；重述用**当初那次**的 timings 快照，不重算；`output_ready` 取重述时刻的真值 |
| ③请求早于真实 ready | 只留一个 `pending_seq`；在**现有发射点**（首帧到达处）同一事件路径兑现，带原 seq；不轮询、不另起管线。`Cancel` 分支调 `on_cancel()` 清 pending；job 关闭随 orch 一起销毁 |
| ④预算 1、不吞首次 | 首次有效查询：ready 已到→`Restated`，未到→`Pending`；第二次→`AlreadyPending`/`BudgetExhausted`。**补确认本身丢失不重试**，仍走端侧 3s 兜底 |
| ⑤日志 | 只记 `trace_id / request_seq / version / decision / budget_left`；发送结果走既有 `control publish result`（event=`session.input_ready.restated`）。**不带 room/SN/token/原始 payload**（grep 该分支 `room =` 0 次）。时基混称已改：`scheduled_at_job_ms` → **`since_pipeline_ms`**（相对 cascade pipeline 启动，非 job 受理），修 B44 坑二 |

**decision 枚举全集**：`disabled` / `rejected_sender` / `rejected_trace` / `rejected_version` / `duplicate_seq` / `pending` / `already_pending` / `budget_exhausted` / `restated` / `pending_fulfilled`。

新增日志形态：
```text
INFO input_ready.request trace_id=<uuid> request_seq=<n> version=1 decision=<枚举> budget_left=<0|1>
INFO control publish result event=session.input_ready.restated trace=<uuid> since_pipeline_ms=<n> send_ms=<n> publish_ok=<bool>
```
⚠️ 与 B44 坑一同款提醒：**这些行不带房号，只能按 trace 检索。**

## 4. 你 §6 自动验收对照 + 负向验证

| §6 自动项 | 测试 |
|---|---|
| 首 ready 先到不多请求；首次查询必答 | `ready_first_then_request_restates_once`（第二次 `BudgetExhausted`） |
| 请求先到 → 真实 ready 时补确认（带原 seq） | `request_first_then_ready_fulfils_pending_with_seq` |
| 重复请求不再登记 | 同上（`AlreadyPending`） |
| 关闭/取消后请求不触发回复或会话 | `cancel_clears_pending_and_later_ready_does_not_reply`（取消后真实 ready 不回应、预算不扣） |
| 错 sender / 旧 trace | `on_control` 校验链（`rejected_sender`/`rejected_trace`），运行时枚举可见 |
| 旧 Worker 忽略未知类型 | 旧版 `parse` 遇未知 `type` 返回 `None` 丢弃——端侧兜底不变 |
| 默认关 | `disabled_never_restates_or_pends`（关着时预算一分不动；配开着时必有动作的正锚） |
| 重述形状 = 首发 + `request_seq` | `input_ready_request_parses_and_restated_keeps_shape`（并锁 `src=worker` 的重述包不被自己入站吃掉） |

**负向验证（每处先确认注入落地再判）**：

| 注入的真 bug | 落地 | 测试 |
|---|---|---|
| `on_request` 去掉预算检查 | ✅ | 2 红 |
| `on_cancel` 不清 pending | ✅ | 1 红 |
| 重述包丢掉 `request_seq` | ✅ | 1 红 |
| `parse` 不再认识该类型 | ✅ | 1 红 |

## 5. 开关与部署计划（按 B37 同一流程，未执行）

- **开关**：`ONESHOT_READY_CONFIRM_ENABLED=1`，**只写进 `/root/rust-worker-firstturn/rust-worker-firstturn.env`**（灰度专属文件）。**绝不写 `/root/rust-worker/rust-worker.env`**——那是生产也在层叠加载的共享文件（B37 已核实）。二进制默认关，装机不自动开。
- **步骤**：核 `voice-worker-firstturn` 空闲（received==closed，停前再核一次）→ 备份现役 `4ba3b3a8…` 二进制+unit+env 到 `/root/b46-backup/`（B36 备份目录保留）→ `install` 新二进制并核完整 SHA = §2 → 只重启该 unit → 核 `/proc/<PID>/exe` SHA、`environ` 里开关键命中 1 次（正锚 `AGENT_NAME` 1 次）、两条采集键仍 0 次、`registered worker`、err 级 0。
- **不动**：生产 `voice-worker-rust`、Session API、灰度名单、TTS 首段开关、AEC/音量/VAD/短词门/STOP·EXIT、追补环（仍 0）、两条采集通道（仍关）。
- **回滚**：停 → 换回 `4ba3b3a8…` → 起；或只删开关键重载 unit（二进制默认关，等价于旧行为）。
- **窗口**：由你定，我不自选；等你确认合同两处收紧后再做。

## 6. 本轮做了什么 / 没做什么

做了：新模块 + 四文件改动、274 测试、四处负向验证、告警位置对撞、整树 53/53 blob 对撞、构建门禁、推分支。

没做：**未部署**、未重启任何 unit、未改任何 env、未铸房、未开采集、未动生产、未改 ready 语义/3s 兜底/首帧发射点、未加重发或轮询、未拿 output_ready 顶替。

状态：**worker 侧就绪，等你确认合同并对接 Android 下一版；整体仍 DEGRADED。**

署名：cc（Claude）| 2026-09-12 13:47 CST
