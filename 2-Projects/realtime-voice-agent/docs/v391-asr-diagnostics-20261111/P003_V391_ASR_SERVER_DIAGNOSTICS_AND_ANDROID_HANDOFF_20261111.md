# P003 v391 ASR 服务端诊断及安卓联调回执

**结论：服务端诊断已上线，服务端隔离验证已完成，可以开始安卓定向联调；历史 ASR 丢 final 尚未根治，v389/v391 不作整体收口。**

## 结论

房间恢复可以分项收口；11月10日8次普通问句无ASR final的历史原因尚不能唯一归因。服务端已补齐关键统计并完成隔离对照，诊断于 2026-11-11 14:37:18 CST 上线，限定尾号03800006，截止2026-11-18 08:46:34 CST；保持现有设备范围和灰度截止，不另扩设备。没有为了通过测试而改ASR供应商、判停阈值、业务空闲关房时间或端侧配置。

历史34房已正常删房并ready_next_wake；普通15轮7成功8失败。失败第二条ASR连接172–512ms完成，RTC音频非零，7/8有本地VAD，未生成问句interim/final，未进入问句LLM/TTS。搜索及TTS不在这8次失败的已证路径内；不能据此反推所有历史慢响应都无关。

## 本轮服务端结果

- 固定实现1cc55436，基线77c33308。746项基线回归通过/2原有忽略；诊断候选752项通过/3忽略（新增真实供应商探针须显式调用）。
- 同一合成WAV（SHA256 9ea46b2c12e570ab71a4b10283c733331d2048331b0b876df47b9a78b10f0b03）独立Python协议实现3/3、Rust适配器3/3均有final；每轮写出92699个样本，非零统计一致。
- 私有LiveKit房间：主池3/3、原倾听池3/3、诊断候选6/6。首轮静音结束→RTC；分别0/450/1000ms后送同一WAV，全部收到问句final并播完回答。真实ASR/TTS、合成LLM，关闭搜索/衔接语并使用独立测试房间；不是Android，也不是原测试WAV精确重放。
- 候选6轮实际WebSocket写出非零样本、队列Full/Closed均0，收54/52/57等响应并各交付2个分句final，播放欠载0。说完到首段有声约0.82–1.45秒（固定合成LLM，本小样本不是生产延迟SLA）。
- 容量：专用worker max_jobs=1，第二房确切decline且未分配；释放后新房ready和问答通过。初次夹具只认主池特有广告日志而误报，原失败保留；改为核直接decline后复验通过。
- 未订阅/输出门：先有供应商PCM但客户端未订阅，没有播放泄漏；5秒输出门失败后删房，再建房问答通过。
- Worker替换：旧job关闭删房后换专用进程，新房/新publication恢复。没有测试共享生产池崩溃、同房热迁移或Android界面。
- 测试前后三池PID/二进制/env摘要一致，私有测试进程全部回收。

这些结果排除了当前隔离条件下的确定性坏链路，不能证明11月10日的间歇失败已根治，更不能只凭模拟成功归咎安卓。

## 诊断字段如何定位下一次失败

只对尾号03800006限时启用，默认其它设备关闭；不记录新增PCM、用户正文或凭据。按输入代次和ASR request_id输出汇总：

| 层级 | 对账字段 | 判断边界 |
|---|---|---|
| RTC/队列 | rtc_seen、rtc_ignored_before_switch、accepted/full/closed | 首轮被忽略音频不能算问句已送ASR |
| ASR发送 | init_written、taken/written、nonzero/peak、首末写入时间、max_write_ms | 写入sink成功不等于供应商应用收到 |
| 响应 | binary/responses、missing_result/utterances、invalid_json、definite/empty_definite、error_code（definite是累计响应帧计数，不能与final_delivered相减计算丢失） | 非零音频不证明可懂；不能将空结果补成final |
| 事件 | interim_delivered/final_delivered、receiver_closed、stage/outcome | delivered指已写入事件通道，消费及业务过滤继续对齐asr final received日志 |

无final时按同一request_id分流：未写出→查服务端交接/发送；写出非零而无有效文本→按响应结构查供应商/协议，并对照源音频；已生成事件但业务未收到→查接收端/取消。不要再把第一条唤醒ASR的no_final当第二条RTC问句的原因。

## 发布、自检与回滚

- 实现源：`1cc55436b79cb6ff9617ad4d5421b1d17525f3aa`；分支 `codex/p003-v391-asr-diagnostics-20261111`。
- 运行二进制 SHA256：`3f81bfc84c14de00e7e139c6f4f2132b3c67e39305148fc461b366df067ae13e`，/proc、磁盘、Worker release声明一致；Brain能力声明同步为同一源提交。
- Grok固定SHA静态对抗审查无阻断，另做6项私有模块夹具通过；未将其当整仓、生产或Android通过。主13独立完成上述Linux回归、真实ASR和私有房间测试。
- 上线后第496.823秒独立复查：PID `217434`、NRestarts=0，registered=true、jobs=0、清理healthy且pending/remaining=0；主池及独立搜索池PID、二进制、环境摘要未变化。
- 发布前第一次健康预检未满足条件，未进入变更；原记录保留。复查并重新通过原门槛后才发布，没有放宽条件。
- 回滚点：Worker `/root/p003-v391-asr-diagnostics-20261111/before-listening`；Brain `/opt/p003/listening-canary-20261030/asr-diagnostics-20261111/before.json`。已核备份原二进制及发布后反向预检。
- 回滚操作仅在空房由服务端执行：先 `rollback-listening.py --check`，再 `--apply`；随后 `brain-release.py rollback <RELEASE-CANDIDATE.json>` 恢复配套声明。两脚本均在上述任务目录；有并发漂移时拒绝覆盖。
- 回滚只退本次二进制/声明和两项诊断键，保留当前供应商key和其它配置，不回灌数据库。未重启主池/搜索池、未改OTA/设备配置、未唤醒真机。

## 安卓现在需要配合的最短测试

无需新增UI、OTA或调整游戏功能。保留v391当前安装状态，先提交原测试使用的WAV原文件与SHA256、驱动脚本版本；仅有MD/JSON/日志不能做原音频精确重放。严禁重复合成同句后当成同一个WAV。

1. 普通对话先跑6轮（3句各立即/延后约1秒），每轮保存完整trace、room、SN尾8位、北京时间、实际播放开始/结束时间、input_phase、麦克风采集/上行帧计数与ASR final。不要只记录UI音量条；旧UI恒1.0不能当PCM能量。
2. 首次出现无final立即暂停批跑，把该轮完整trace和前后相邻成功轮回传；服务端按新增统计即时定位，避免再累积一整批只有“失败”的结论。若6轮通过，再扩为30轮（3语料×2节奏×5），并补少量真人口述。
3. 倾听3轮：进入→讲述60秒→完整退出口令→同房短问→关闭→再次唤醒；触摸关闭后再唤醒5轮。分别对齐退出proposal/完成、旧房删除、新房final及答案，不混为一个PASS。
4. 三组受控异常须约定有人在设备旁：容量；no-subscribe与输出门失败（两个独立断言）；Worker替换。服务端已做隔离验证，下一步只在专用测试池执行定向注入，安卓确认错误提示、退出恢复、下一次唤醒。不要重启共享生产池或调低全局容量来模拟。

建议回执表：轮次/输入类型(原WAV声学或真人)/WAV SHA/完整trace/room/开始结束CST/已发麦克风样本/final/听到正文/退出与下次唤醒/异常备注。无正文可用哈希/字符数，对账无需手机号、token或用户历史对话。

## 收口标准

房间恢复分项通过不必反复重做；普通30轮与倾听/触摸回归不再丢final，且每个失败有对应发送/响应证据才能关闭ASR项；三组异常以服务端证据+Android实机恢复共同关闭。不能承诺一次30轮等于永久零故障。

署名：codex（OpenAI）| 2026-11-11 14:56:11 CST
