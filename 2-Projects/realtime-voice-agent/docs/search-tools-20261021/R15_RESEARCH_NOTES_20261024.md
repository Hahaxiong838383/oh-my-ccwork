# R15 排查参考、实际采用与边界

状态：2026-10-24 执行中，设备派单关闭。代码及候选部署不等于验收通过；最终状态见本目录 R15 验收记录。

1. [tokio-tungstenite 0.30.0 连接实现](https://raw.githubusercontent.com/snapview/tokio-tungstenite/v0.30.0/src/connect.rs)：按项目锁定版本拆出系统解析、TCP、TLS/WebSocket三个阶段。保留地址顺序、证书、TCP默认行为和整体10秒期限；TLS与WebSocket仍合并计时。没有增加并发或无限重试。
2. [Linux resolver 手册](https://man7.org/linux/man-pages/man5/resolv.conf.5.html)：默认解析重试等待可达5秒，`RES_OPTIONS`可按进程设置。真实候选连接出现DNS 5010ms；另一次strace证明连接本机53端口后poll超时5005ms。首次80次独立查询没复现长尾，不能据此否定现场失败。
3. [systemd-resolved说明](https://www.freedesktop.org/software/systemd/man/latest/resolved.conf.html)：系统已有TTL缓存，不再增加写死IP或任意固定TTL缓存。本轮没有更换全机DNS、关闭IPv6或猜测证书问题。`single-request-reopen`的适用原因未被证实，未启用。
4. DNS采用候选进程专属`timeout:1 attempts:2`。在隔离网络/挂载命名空间注入丢首轮响应：默认5073ms、候选1100ms，均成功且均4请求；持续丢包时默认10389ms、候选2462ms，均失败且均4请求。配置降低重试等待，也会更早失败，必须继续核实际成功率；它不是“网络永不慢”的保证。相关脚本和恢复说明保存在Worker的`rust-worker/ops/`。
补充真实复测：R15d普通聊天第15个计划配对的B轮，两个TTS预连接DNS分别约4005ms、4004ms失败，随后新连接DNS约399ms成功；预连接等待4065ms、正文首帧5599ms。`timeout:1`不是getaddrinfo整体上限，故不能把隔离故障中的约1秒恢复推广到所有真实情况。DNS仍未解决，配置效果只记部分缓解。

5. [LiveKit AudioSource](https://docs.livekit.io/reference/python/livekit/rtc/audio_source.html)和[音频发布说明](https://docs.livekit.io/transport/media/publish/)：capture_frame只是入队。按安装的SDK 1.1.9源码核实publish_track会保留track引用；不再猜测GC。探针记录input_ready、上行包增长、正文首PCM和接收音频，并固定WAV、采样率、帧长、DTX。历史无PCM的几次样本仍未定根因，不以本轮成功追认。
6. [讯飞资料入口](https://docs.iflyaicloud.com/doc/31/)本轮正文抓取超时，不能据未读正文改变协议。已知单连接合成生命周期继续以项目实测为准。
7. 开场回声门实际吞掉搜索正文期间的单字“对”。修复只豁免已由搜索会话判为完整附和的输入：真实结果active、首PCM已发、输入结束、精确词匹配。其作用只允许同任务续播，不派新任务、不起普通聊天。普通开场回声、停止/退出及完整插话保持原规则；先红后绿回归覆盖真实失败条件。
8. [中科院华南植物园](https://scbg.cas.cn/hx/201107/t20110726_6734430.html)区分小叶闭合与复叶叶柄下垂；R15d回答仍混用其部位，不通过。[故宫官方导览](https://www.dpm.org.cn/Visit.html)的节假日例外则已保留。固定20条R15d均ready/answered、有来源，但不能写成20条内容验收通过；Q07还出现未问的旁枝日期。
9. [Anthropic事实依据建议](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-hallucinations)建议逐项寻找支持引用；[自我纠错研究](https://arxiv.org/abs/2310.01798)也提醒不能把模型自行复查当作外部正确性证明。论文有特定模型/任务范围，不能据此断言当前所有模型都不能纠错。本轮实际采用最多一次、有原问题及具体数值反馈的复核，保留20秒/一次检索/最多两次答复生成预算；它改善了一些问题，但含羞草失败说明还需独立内容判断。下一步应研究“来源原句→主张→简短口语”的可核对链路，不继续靠增加复查轮数追绿。

测试与工具失误也保留：早期错误端点/预览路径导致的未派单试次单列；真实派单的失败不删除。恐龙查询的answer/unasked_quantity已取证，不能套用到R14未分因的search_unavailable。一次npx误解析到非TypeScript的tsc包，未作为类型检查通过；改用项目已安装的`.bin/tsc`完成检查，未改依赖清单。

R15c附和回放中：部分未识别，一次被识别成其他词，两次“对”被开场回声吞掉。没有把这些记为通过，也没有给ASR强加短词热词。开场门修复后的真实识别覆盖仍按R15d证据重新计算。

运维连接曾出现家中跳板与Air直连分别超时；按已知主机密钥切换既有路径，不迁移私钥、不关闭host key校验、不改业务网络。服务器侧限时单路批次和finally/ExecStopPost负责恢复最终候选并关窗；控制台连接成功与候选业务健康必须分别核实。

## 最终回放后的补充参考

- RTC批次之后只读对照本机stub和既有两上游的UDP/TCP：5组各20次A记录查询均成功，各组成功P90约50—61ms；没有修改或清空系统DNS。此次未复现长尾，不能否定此前getaddrinfo的4005ms失败，也不能证明改TCP可修复。该探针只查A记录，未覆盖真实系统解析的A/AAAA组合；下一步应在该真实路径记录请求/响应配对和超时位置。
- [LiveKit短语音排障](https://livekit.com/blog/short-utterances)区分无最终转写、判停过早/过晚、降噪及附和处理。采用其逐层核查思路；不能通过缩短全局判停来修本轮短词错转，也不能把合成输入的预期文本当成实际ASR。
- [LiveKit自适应打断](https://docs.livekit.io/agents/logic/turns/adaptive-interruption-handling/)从声学信号区分真正插话和附和，但对应Python/Node Agents及LiveKit Cloud推理条件。当前P003是自建Rust链路，不能直接抄配置便声称已具备该能力；未来评估需要额外中文音频及延迟证据，本轮未接入。
- [上游案例4498](https://github.com/livekit/agents/issues/4498)报告短词缓存在下一轮污染上下文，维护者不建议仅凭词数丢弃输入。它是其他版本的案例，不是本项目根因证明；本轮借鉴为检查消费后的文本清理和后续新轮，不新增全局吞短词规则。
- 本轮探针静态版本字段遗留R15c值，实际运行PID/启动时间/进程SHA和Brain源码另行核对。保留原始输出并在最终证据明确更正，不能静默重写历史标签。设备实听仍未代验。
- 首次最终到期演练因SSH断开而失败；封装只打印退出码、没有传播非零退出，上层又提前执行到期检查。恢复原截止后，仍在远端收尾的子进程又写回了旧短截止，形成测试工具自身的清理竞态。生产派单始终关闭；确认探针退出后修正期限，并将新工具改为传播退出码、只关闭当前闸而不回写整份旧窗口，采用独立文件名重试。失败原件保留；最终是否通过以实际关房时刻和断连证据为准。

署名：codex（OpenAI）| 2026-10-24
