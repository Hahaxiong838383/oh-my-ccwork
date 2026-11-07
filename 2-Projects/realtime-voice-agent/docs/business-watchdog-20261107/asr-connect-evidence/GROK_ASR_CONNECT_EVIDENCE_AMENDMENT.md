# Grok 证据增补：严格探针已补上第二轮缺口

身份：xAI Grok 4.7。只读增补。没有重开根因，没有改源码，没有部署，没有 SSH，没有复跑全套。旧文 `GROK_ASR_CONNECT_FINAL.md` 与 `GROK_ASR_CONNECT_FINAL.json` 保持原样。第二轮当时依据 `ASR_CONNECT_RTC_READ_1`：metrics 未按合同计数，`ordered=1` 的结果是空。那两条只针对那份读回，不覆盖下面这次新证据。

## 直接核对的文件

| 文件 | sha256 |
| --- | --- |
| `GROK_ASR_CONNECT_FINAL.md` | `3351a93767da478f3ce5d7b8d73d3ea5b550515bdf3f0d21222292eacad37296` |
| `CODEX_ASR_CONNECT_DISCUSSION.md` | `9258e63d6deb8a621e8c49d801a9ff0f7f030770a78f11942036976f367b684c` |
| `ASR_CANDIDATE_FINAL_RUNTIME.json` | `1346d658fcbaca8066ef6910d79ef92fdac00d441013c132da73c60ce9cc1835` |
| `ASR_METRICS_RTC_READ_2.json` | `b5d812bd161443c659cec3c5a3a485da54209fb81f032259f98108f94f761f7e` |
| `worker-asr-connect-wire-final.log` | `46cabd019625040bcc1f2c4f135c27264fd943a32e8f174f7f974cf7d836b988` |
| `source-asr-connect-wire-final.json` | `714fcde0d83dd5728c2ac7ccc8dedde9f6a4fb2ba6df103dc07787175c102625` |
| `source-asr-connect-release.json` | `066b0ccc4678b128d321179660ebeb1082f0ed8cdafa9df8e1aa9cda40d15018` |
| `WORKER_ASR_CONNECT_RELEASE_STAGED.json` | `ddc9c882657ebcb708f8062b7e349aef5f1729940f78f476a632607ff3d393f9` |
| `deploy-asr-connect-release.py` | `ebdc6ba8f7bfd8b12948059109b57975f2f90d4658d9b4f98ba45d8dfdf0a831` |
| `release-dispatch-probe-asr-connect.py` | `31199f2d26bdbcde2e4924b6e2ea7982699c2d25365bce91520737dcc9312b58` |

本地 `HEAD` 是 `713f6f35af43d5a58aeae8360ad421fc66b72718`。工作区 `src/stt_volc.rs` 为 `3902d5e721e8f2804d051be1d630692330fcaee69c156d575f922ed7ef771e6c`，与 wire 清单一致；该提交上的同文件是 `5283ec77046320707020c6bea20e357229e1e4f6f2021dca0f950770fcef8b90`，与 release 清单一致。`src/rtc_business_probe.rs` 工作区 `966014da3fa9f78b3fea7dd924774fbbe10fc8180de33921dd936ce817f59a20`，提交 `ebf0ad84c1994f2d682431a395e8581ef694290558acc2297d1847e5253be02d`，同样分别对上 wire 与 release。两份清单 68 项里只有这两个文件不同。

相对 `713f6f35`，运行源码脏改只有这两处，且都在测试里：`stt_volc.rs` 在 `#[cfg(test)] mod tests` 增加 `delayed_six_second_handshake_delivers_final_before_recognition_hold_expires`；`rtc_business_probe.rs` 在已有的 `#[tokio::test]` `#[ignore]` 探针里记录 metrics topic 的 `k`。同索引里还有业务看门狗证据文档，不是运行逻辑。release 清单等于已提交树，所以 `3dd0430a` 不包含这两处未提交测试。

## 旧缺口里已经盖住的部分

`worker-asr-connect-wire-final.log` 末行是真实全套，不是过滤计数：`ok. 542 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out`，10.52 秒，日志头 `rc=0`。其中 `delayed_six_second_handshake_delivers_final_before_recognition_hold_expires` 为 ok。`ASR_METRICS_RTC_READ_2.json` 里两行 `542 filtered out` 是单次探针只跑那一个 ignored 测试，不能拿来否定这份全套日志。

`ASR_CANDIDATE_FINAL_RUNTIME.json` 与 `ASR_METRICS_RTC_READ_2.json` 是同一对严格 RTC，日志 sha 互相一致。测试二进制是 `fc1e8a496027878807adc5a06a813ef349ce2de022c79c530326540740f298c7`。进程直接跑 job，`worker_alive_before_cleanup=false`。主进程仍是 PID `3496776`、`NRestarts=0`、二进制 `50017a8998197d84fcc58957e0979ea13f56aabe0758ba9ea2ab2aff468de4d0`。结束后房间数 0。

- 普通：`exit=0`，`ordered=false`，`user_finals=2`，回答 1，`audible_ms=6000`，`metric_kinds=[eou,eou,llm,tts]`，连接 `elapsed_ms=392`（DNS 103、TCP 33、TLS/WS 253），`Close(IdleNoProgress)` 后 `cleanup=Gone`。`unused_closed=0`，`panic_count=0`，`asr_no_audio=0`。房间 `sn-BJP00326110799999901-1794072815368`，SID `RM_BfJjhdu7PTRP`。
- ordered：`exit=0`，`ordered=true`，`user_finals=2`，回答 1，`audible_ms=8400`，`phase_ms=4954`，同样四类 metrics，`session.input_phase` 后 `Gone`。两次建连，440 毫秒与 288 毫秒。`unused_closed=1`，`panic_count=0`，`asr_no_audio=0`。房间 `sn-BJP00326110799999901-1794072887641`，SID `RM_mH55pKpnPnSz`。

因此第二轮「metrics 未测、ordered 为空」不再成立。`unused_closed=1` 记在 ordered 这一轮的计数里；该轮合同仍然通过。这次不把它重开成根因。

语料仍是固定自制 `normal-short.wav`（sha256 `9ea46b2c12e570ab71a4b10283c733331d2048331b0b876df47b9a78b10f0b03`）经真实 RTC。这是预发布隔离样本，每条路径各一轮。

## 还不能在部署前测的部分

`WORKER_ASR_CONNECT_RELEASE_STAGED.json` 只说明 release 二进制 `3dd0430aaf97d3ef5d056d871f3d87a64c66508c0b9b8cf9702bc9f0e73e70cb` 放在 `/root/p003-business-watchdog-20261107/worker-asr-connect-3dd0430a`，76096576 字节，26 段。现役主进程 exe 仍是 `50017a89…de4d0`。正式 release 未安装。

`release-dispatch-probe-asr-connect.py` 在开跑前要求现役 exe 等于 `3dd0430a`，并且进程环境里 `P003_ASR_CONNECT_RECOVERY_V1=1`。它按参数跑普通或 ordered，派给 `rust-worker`，要求 `user_finals>0`、有回答、`audible_ms>=500`、ordered 必须有 `phase_ms`、房间自然消失、metrics topic 有包，并且探针期间主进程身份不变。脚本自己写明 `real_android=false`，元数据是操作者签发的合成票，不是设备 `cfg-139`。这一验收必须先完成受控安装才有对象可测。

`deploy-asr-connect-release.py` 已读、未执行。它要求：现役 exe 与磁盘二进制都是 `50017a89…de4d0`，暂存文件是 `3dd0430a…70cb`；`ListRooms` 为空且主单元没有未结束 job，cleaner `healthy` 且 `remaining=0`；环境里还没有 `P003_ASR_CONNECT_RECOVERY_V1`，安装时只给主池环境追加 `=1`；逐项备份主二进制、`rust-worker.env` 和主单元文件；搜索池与倾听池的 PID 和 exe sha 在安装后必须不变；单元文件和 DNS 负缓存文件不改。失败时停服务、还原备份二进制与环境、再要求旧 sha 完成 worker 注册；还原本身失败则留下 `rollback-needs-review.json`。源码提交字段写的是 `713f6f35`。

主池这个 ASR 开关写在整个 `voice-worker-rust.service` 的环境里，一旦安装就对主池连接生效。业务 watchdog 的 enforce 仍走既有名单。生产回执写明真实名单是 `02000053`，另保留合成身份 `99999901`。这不能称作全功能单 SN 灰度。

## 结论

没有新的具体代码阻断，也没有新的预发布隔离 RTC 阻断。第二轮留下的 metrics 与 ordered 缺口已被上述严格探针盖住。

同意进入有回滚的主池受控发布。保留上线的条件是：安装后的 `3dd0430a` 用 `release-dispatch-probe-asr-connect.py` 做普通与 ordered 各一轮，两轮都要有严格 metrics、自然关房，且运行进程仍是这个 release。任一轮不成立，就按部署脚本回到 `50017a89…de4d0`。

这不是无条件批准。不宣称 Android 通过，不宣称历史失败根因已关闭，不宣称其他池通过，不宣称黑洞地址端到端已验。
