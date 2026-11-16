# ASR 三台诊断固定候选复验

审查对象：固定提交 `262dfe9c0a7bc9c44769670e0312bcb66cb32671`。父提交 `37c7a98f5d1a9dd5bb238fadbc4d594bec357c52`。只读。未改该提交的源码，未动生产、设备开关、凭据或供应商正文。未跑私有 SFU，未调用供应商，未改发布器。

署名：grok（xAI）| 2026-11-16

## 结论

前轮两处阻断在这个提交上关闭。结论只到固定候选的本地 / 隔离代码验收。

`262dfe9c` 的回执要求完整 `BJP003` 加 14 位数字，并且房间与 SN 一致。同房再出现别的 trace 或 job 时 CLI 为 1。runtime 要带上与日志属主相同的 pid / unit，以及格式合法的 agent、64 位二进制 SHA、40 位源 SHA。connection 与同 PID、同一 `input_generation` 的唯一 input summary 对上，重复 `request_id` 不能覆盖。Rtc final 条数若多于「written.samples>0 且 responses>0」的 connection 上 `final_delivered` 之和，覆盖为 `NOT_COVERED`，CLI 为 2。

正例不误拒：完整 SN、绑定齐全、同房没有第二份 trace/job 时 CLI 为 0。另一房间的其它 job / trace 不把这条打成失败。CLI 为 0 的回执仍是 `physical_device_participated=null`、`original_no_final=unlocated`、`asr_root_cause_closed=false`。COVERED 只表示诊断字段闭合。

本轮没有音频。计数可以是 0。没有 Rtc final 日志时结果是 `NO_FINAL`，CLI 为 2；这时覆盖仍可以是 COVERED，计数 0 是有效失败现场。有 final 日志但写出、响应、交付没有正计数支撑时，CLI 为 2，覆盖为 `NOT_COVERED`。没有把「所有失败现场计数必须非 0」当成条件。

未部署。三台完整 SN 仍待用户点名。隔离夹具通过不作为真机通过，也不作为原 NO_FINAL 已定位。

## 固定 SHA 与六文件

开评时 HEAD 等于该提交，工作树干净。该提交相对父提交只有这 6 个路径，+122/−14。

| 路径 | 本提交 SHA256 |
|---|---|
| `rust-worker/src/asr_diagnostics.rs` | `8890d81429726a9fb412f9141442d58b272fb64fe6e9b1467118659ad7862ea1` |
| `rust-worker/src/pipeline.rs` | `44961797abdc938350f449e8dd8d7e245ac064d4d1dabb90c41226028abf4c77` |
| `scripts/asr_diagnostic_receipt.py` | `376c6bb43e273aadc8c55324a0e8a25b65e6c8b98ea84cab181a8a7a0ee6f0a6` |
| `tests/test_asr_diagnostic_receipt.py` | `6b4118e8ec4d03e099ea88f81f2a283b5f924fe3e365eae5300c58533cb37fb4` |
| `docs/asr-three-device-20261116/PLAN.md` | `ae5ae3f2364589bdc5deb0acc7586d072511c0d0ab158422d4af967a0ece93fe` |
| `docs/asr-three-device-20261116/ROLLBACK_AND_RELEASE.md` | `05771350b3f0f3284022879d067ad4a515d881d4df72c2499872f85951cb0b59` |

`source-final-all.json` 与 `source-final-release.json` 字节相同。其中 `asr_diagnostics.rs`、`pipeline.rs` 与上表一致。`main.rs` 仍是 `18a82bf6b453523bac0037f929e1784f1d87dca46bf68f0c40d17433e380f399`，`stt_volc.rs` 仍是 `e877850ec6b3562098719f824aa75933a376dc9f5a38d868ddcbb5f468700a30`，与父提交相同，也与这两份 JSON 相同。相对基线 `f5b2fd61916022a67c32dfbd5c3fd33ca5c2829a`，rust-worker 内容差异仍是 `asr_diagnostics.rs`、`main.rs`、`pipeline.rs`、`stt_volc.rs`。

Rust 增量：`PcmSender::send` 标了 `#[cfg(test)]`，并在诊断对象存在时断言失败；生产入队仍是 `try_send`。两处预连测试从 `try_send` 改回 `send().await`。`input_generation` 仍是 `Uuid::new_v4()`。input summary 这行本身不写 room，回执用 connection 上的 generation 去对同 PID 的唯一 summary。

计划第 4 步改为既有本地 WebSocket 假供应商夹具，写明不新增私有 SFU、不调用真实供应商。第 5 步写明发布器本轮只读。这次差异里没有 SFU、供应商或发布器代码。`ROLLBACK_AND_RELEASE.md` 写明尚未部署、完整 SN 待用户指定。

## 前轮阻断

### B1 关闭

父提交用 `[A-Za-z0-9]{8,64}`。本提交改为 `BJP003[0-9]{14}`，房间必须是 `sn-<该 SN>-<数字>`。

独立 CLI：`03800006` 与合成尾号 `99999901` 都是退出码 1，`ValueError: full device_sn required`。`BJP00326111699999901` 与历史形完整号 `BJP00326070803800006` 在绑定齐全时退出码 0。格式通过不表示这台已进入核准名单。

### B2 关闭

父提交里，0 计数且汇总行没有 trace 时，同房同 pid 的 Rtc final 仍能让成功谓词为真。本提交把成功谓词留在 `main()`：退出码 0 需要 `coverage==COVERED`、`job_closed`、`question_final`。final 条数若大于合格交付之和，原因是 `rtc_final_delivery_not_correlated`，覆盖变成 `NOT_COVERED`，退出码为 2。

独立 CLI：`written.samples=0`、`responses=0`、`final_delivered=0`，同时保留一条 Rtc final，结果是退出码 2、`NOT_COVERED`、`FINAL_OBSERVED`。`samples=0` 而 `final_delivered=1`、`responses=1` 同样是退出码 2。零计数且删掉 final 日志：`COVERED`、`NO_FINAL`、退出码 2。有正计数但没有 final 日志：同样是 `COVERED`、`NO_FINAL`、退出码 2。后两种是诊断得出来的失败，退出码不是 0。

## 独立反例与正例

脚本从 `git show 262dfe9c` 取出后执行，不使用工作树副本。19 项单元测试 OK，0.010s。下表是另写的 CLI。

| 探针 | CLI | 覆盖 | 结果 |
|---|---|---|---|
| 完整绑定正例 | 0 | COVERED | FINAL_OBSERVED |
| 正例加上另一房间的其它 job / trace | 0 | COVERED | FINAL_OBSERVED |
| 完整号 `BJP00326070803800006` | 0 | COVERED | FINAL_OBSERVED |
| 尾号 `99999901`、`03800006` | 1 | 拒绝，不写回执 | |
| 同房其它 job（同一 trace） | 1 | 属主不唯一 | |
| 同房其它 trace | 1 | `room contains another trace or job` | |
| connection 与 input summary 的 generation 不一致 | 2 | NOT_COVERED | FINAL_OBSERVED |
| 同一 generation 两条 input summary | 2 | NOT_COVERED | FINAL_OBSERVED |
| 零计数加 Rtc final | 2 | NOT_COVERED | FINAL_OBSERVED |
| 零样本但 `final_delivered=1` | 2 | NOT_COVERED | FINAL_OBSERVED |
| 零计数且无 final | 2 | COVERED | NO_FINAL |
| 有正计数且无 final | 2 | COVERED | NO_FINAL |

身份类拒绝是未捕获的 `ValueError`，退出码 1。覆盖类失败退出码 2。两类都不是 0。套件里的 `test_same_room_different_trace_or_job_is_ambiguous` 覆盖同房其它 job 加其它 trace，已在 19 项里通过。正例回执不含 `chars=7` 正文。`worker_runtime` 只留下 `agent_name`、`binary_sha256`、`source_sha`。

`receipt-delivery-red.log` 是 19 项里 1 项失败：交付未闭环时当时得到 COVERED。`receipt-final-green.log` 是 19 项 OK。红日志对应的中间脚本不在 git 里，本评审没有把那次红再演一遍；固定提交上的重跑是绿的。

## 历史四轮与发布日志

`HISTORICAL-NEGATIVE-FINAL.json` 的 `passed` 为 true。四份都是 `NOT_COVERED`，`physical_device_participated` 为 null，`original_no_final` 为 `unlocated`，`asr_root_cause_closed` 为 false。问句 final 为 true / true / true / false。前三份 `FINAL_OBSERVED`，第四份 `NO_FINAL`。SN 都是 `BJP00326070803800006`。回执字段里没有转写正文。`passed` 表示负例断言成立。本评审没有重跑采集脚本。

`worker-final-all.log` 头里的 `pipeline.rs` 哈希等于本提交，结果 616 passed、0 failed、2 ignored。`worker-final-release.log` 头里的同一哈希相等，`rc` 为 0，产物 SHA256 `d37a39633ed8e7766e35744baf0b78ca2fbc12777a91b9a89f166029748c1c69`，76399176 字节。两份日志都是读到的记录。本评审没有重跑 cargo，也没有重编 release。日志末尾的部署命令没有执行。

## 边界

- 真机、部署、生产进程、三台名单都不在本结论里。名单仍等用户确认。本文件不请求把已授权的代码开发再批一次。
- runtime 的 agent 与两枚 SHA 做格式检查，并与日志里的 pid / unit 对齐。本评审没有打开那份 release 二进制去核对里面的 SHA。
- final 日志没有逐条带上 `request_id`。约束是条数不超过合格 connection 的 `final_delivered` 之和。`request_id` 不重复；代码没有再要求全局只能有一个 request。
- input summary 可以不带 room。带了其它 room 的不计入。generation 是 UUID，同 PID 下靠这个值闭环。
- 退出码 0 只出现在覆盖、job closed、以及至少一条已被正计数支撑的 Rtc final 同时成立时。它不表示硬件参与，也不表示历史 NO_FINAL 已定位。
- `#[cfg(test)]` 的 `send` 只在源码里核对过。没有对 release 二进制做符号检查。
- 复验结束时工作树出现两份未跟踪文件：`docs/asr-three-device-20261116/REVIEW_RESOLUTION.md`、`SELF_TEST.json`。它们不在 `262dfe9c` 里，不作为本结论的证据，也没有被修改。
