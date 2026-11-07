# 剩余验收（2026-11-08）

对照联合方案的剩余项。不重审已验收的主池 e980/057f。主池与倾听单机已发布，各有隔离 RTC 证据。Search f576/56f6 主 Brain 未选用。维持单机范围。隔离合成会话不是真人。

## 计划与证据

1. 单机无进展回收：00:37:20 原房 RM_D6tdPrWhteMk 已 Gone，禁止再删。00:44 仅 02000053 写入 cfg-139，空闲 5000ms，签票 voice_idle 与 rust-worker 一致；名单另有合成 99999901。e980 仍接 job.rs:124 from_env、:272 仅 Close 跳出；business_watchdog.rs:70 缺 idle_ms 则 Observe(UnknownPolicy)，不关房；pipeline.rs:1450 用搜索 business_deadline。倾听 05:58 起仅 03800006 / cfg-140，源 85de、二进制 636b。主 env 仍 5c15。Brain 仍只把 038 派到倾听。
2. 建连与流中分层：4704 已拆成 connect_id=2 的 dns4704/tcp51/tls170，无同次 DNS 包。00:18 信令 transport timed out（到 connected 6077ms）与历史 6075 的 10 秒预算，尚未证明落在 TLS。另测 LiveKit 系统解析 6375ms 时 TCP/TLS 仅十余毫秒，是另一次测量。t22 首包成功后 3 次欠载共 2922ms，无 pause、无 StreamTiming、无包。主池自 b911 有同连接诊断，e980 仍在该谱系。其后绿探针为百毫秒级且欠载 0，不能解释这三次。
3. 真机同 trace 与 12 票：未闭合。12 票只对过一份 11 房 SFU 快照（RECONFIRM_TWELVE_SFU.json 写明不是 connect 失败证明）及当时 Worker 包：签发在、派单不在。该包无 SFU 传输统计，Brain 合同摘录仅 3/12。

## 三类缺口

派单路径上没有新的必改代码缺陷。Search 仍缺连接诊断、有界 ASR 预连、recover_connection 和业务关房，pending_state 的 25 秒不关房。它没有当前会话，不解释 53/038，现在不补丁、不部署。

不靠新安卓、也不重跑绿测时，服务器只剩一件取证：若 11 月 7 日 15:06–17:01 日志仍在，按 12 个房间尾号对 Brain 签发、Worker assignment、SFU 房间；仍无 assignment 即停止。主 13 若在发布后日志里看到真实 02000053 或 038 会话，只核同 trace 的 voice_idle、关房与 PCM。只有运维合成票时，到此为止。无新慢样本时不改诊断字段，也不补解析库重试序号。

其余是外部最小缺口：02000053 端上是否拿到 cfg-139，以及主池真人短句、慢建房后首句、关房后再唤醒。服务端策略按签票 metadata 生效。03800006 端上是否应用 cfg-140；三轮普通问答；倾听 60 秒并含 20 秒停顿；三条退出口令后同房再问，再核空闲关房。生产进程正向语音不能用隔离 2/2 或被名单拒绝的探针代替。历史原因只缺：4704 的 DNS 包、386ms 备用失败、上述 10 秒预算的同次分段、t22 的供给与播放分段。下一次同 PID/connect_id 慢样本再用现有字段；原始包已不在则保持未证。最初无有效输入仍缺麦克风、权限、静音记录。整数 mean_amp=0 不是逐样本全零。

回滚用现行锚。主池：标签 rollback/p003-main-asr-handoff-pre-20261108，备份 asr-handoff-before，旧二进制 ca41b535，脚本 rollback-main-handoff.py。倾听：标签 rollback/p003-listening-watchdog-pre-20261108 指向 22ab1c31，运行回退 50bac0b2/1e9ec83a，先撤 cfg-140。00:49 回执中的 35f59ecd 已过时。旧房清理不能靠回滚重建。

结论：单机保护、分池发布和回滚已落地。现在没有必须改的服务器代码。留存期外没有 12 票日志时，剩余全是上面四条外部证据。
