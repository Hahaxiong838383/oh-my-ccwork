# P003 TTS 优先修复与验收回执

更新时间：2026-11-06 00:05 CST（部署为11月5日23:47）。结论：**未完全解决。Worker 的串行建连等待放大已修复上线；历史 TLS/WS 超时的底层原因、流中停顿仍未闭合，不能整体收口。**

## 1. 已确认的原因与本次改动

历史连接6075在DNS5ms/TCP64ms之后未完成TLS/WS，10秒预算到期。正文turn11等待预建连8463ms，后面又新起冷连接893ms，取消时played_frames=0。这证明Worker会放大单次握手异常；该异常调用发生在Worker到讯飞链路，安卓不执行这次DNS/TLS请求。不能因此排除安卓其他独立问题，也不能将“搜索任务数0”当作搜索相关共享代码没有回归的证明。

本次只在文本发送前恢复连接：句ready起共享10秒截止；650ms仍挂时最多一个并发备用，进程最多2个额外并发、不排队；已有fresh预热直接用。失败/超龄不重置第二段10秒，赢家只发一次文本，输家取消。两个连接都失败仍报错，无法保证供应商整体不可用时也出声。

独立开关 `P003_TTS_CONNECT_RECOVERY_V1=1`；保留 `P003_ASYNC_DNS_V1=1`。没有启用会连带影响衔接语的 `P003_TTS_LATENCY_V1`。流中已交付PCM后不整句重试，避免重复说话。

## 2. 部署与回滚

| 项目 | 实际结果 |
|---|---|
| 上线时间 | 2026-11-05T23:47:17.260718+08:00 |
| 运行源码 | `19ac09674c0d42d91419ec8411e7175c34b3c204` |
| 主池二进制SHA256 | `f7dfdd4517fc2addb41b393c10f232a19d074e0752c6abb8977e08f11a7b7ed0` |
| 进程 | PID3021826，NRestarts0；最新取证持续571.6秒 |
| 影响范围 | 仅voice-worker-rust主池；搜索/倾听专池、Brain/数据库/设备配置未改 |
| 回滚基线 | 06eb839d版本，保留ASYNC=1 |
| 回滚目录 | `/root/p003-transport-diagnostic-20261105/rollback-main-recovery-19ac0967` |

回滚命令（先由内置检查确认自然idle、二进制/环境无漂移）：

```sh
python3 /root/p003-transport-diagnostic-20261105/rollback-main-recovery-19ac0967/deploy-recovery.py --rollback
```

备份包含旧二进制、三份环境原件、逐项摘要和部署回执。不要使用上轮回滚点直接退到52f旧版本，不整树覆盖、不回灌数据。

## 3. 自检验收

- 核心3项先复现红灯再修复；固定候选484项全过，后续只补真实foreground owner取消测试后485项全过。release与glibc/libstdc++ ABI门禁通过。编译仍有基线dead-code警告，未声称零警告。
- 本地真实WebSocket握手挂起：备用接管、输家EOF、文本请求唯一；双挂起共享截止；容量耗尽、主/备失败、过龄、取消均覆盖。
- 流中500ms/2秒断供、channel背压、partial close、zeroPCM分别验证。2秒断供能在NativeAudioSource形成欠载；这些是隔离故障，不是历史t22的根因证据。
- 独立Worker已完成一次真实ASR→LLM→TTS→RTC，收音约11.21秒，播放欠载0，SourceDrained；临时unit已停止、房间与资源已清理。独立agent使用系统DNS，这一轮不能冒充主池新DNS的测试。
- 主池上线后2轮完整语音链路：实际收到约17.49秒、14.97秒有声音频，两轮SourceDrained、欠载0；9段TTS首PCM 260–322ms，11次建连199–303ms，全部独立A/AAAA路径；不是设备02000038真人实听。
- 当前ERROR0、WARN3：2条测试关房请求；另1条NativeAudioStream启动期丢1帧，发生在ready前约95ms、测试语音输入前约96ms。Worker该流为上行麦克风输入，不将其写成TTS输出丢帧，也不称零告警。
- 16次供应商短/长句独立Python对照均成功；后8次有双向TCP头，无捕获错误/环形截断。其中1次出现重复TCP数据范围；主13与Grok复核本机已发ACK覆盖这些数据，重复段不能当成补洞或供应商丢包。270ms块间隔与约268ms新TCP载荷间隔对齐，不能解释历史2922ms欠载。理想消费模型无断供，不是真实设备播放指标。详见GROK-TCP-EVIDENCE-REVIEW.md。

## 4. Grok复审与边界

Grok108对固定19ac0967源码给限定范围PASS，无代码阻断；未独立运行测试或SSH，并建议等真实故障再开新旗。主13已完成额外的485测试、独立及主池RTC和回滚取证，裁决先修复已证的应用层等待放大；没有把其建议改写为“同意上线”。原文及裁决见 `GROK-FIXED-CANDIDATE-REVIEW.md`、`CONNECTION_RECOVERY_DECISION.md`。

**仍未验：** 真正6075同型故障发生时备用是否能接通；真实设备02000038使用感受；历史t22为何在首PCM后3次欠载共2922ms。不能因正常测试全过而宣布根治。

## 5. 后续执行顺序

1. 已升级独立metadata记录器v3，5项测试和Linux smoke通过；SACK/时间戳/窗口缩放、抓包socket内核丢弃计数已补齐，旧v2尾记录保留，Worker PID不变。保留记录器至 **11月6日22:27:05 CST**，自动停止；按同PID/连接ID/本地与对端端口匹配TTS异常及双向TCP头。它只自动记录，未配置智能体全天自动分析。
2. 出现新的慢握手或流中欠载后，先核证据覆盖，再分开判断TCP重传/ACK、上游未供给、Worker收流调度、正常channel背压；没有事件不能补造根因。
3. 若证实链路或供应商问题，再作针对性链路/供应商方案；当前不凭猜测换服务器、改变音色、加大播放缓存或重播整句。
4. 目标设备自然会话或同事真人复测后，以同trace的ASR final、正文首PCM、播放欠载及用户实听收口。另有“partial PCM错误时进度未记入字幕”的旧边界，已记录，不冒充本次t22根因。

实施计划：仓库 `docs/superpowers/plans/2026-11-05-p003-tts-priority.md`，Downloads分发包内有同名文件；机器证据：`TTS_RECOVERY_RELEASE_EVIDENCE.json`。私有原始数据不随回执外发。

署名：codex（OpenAI）| 2026-11-06
