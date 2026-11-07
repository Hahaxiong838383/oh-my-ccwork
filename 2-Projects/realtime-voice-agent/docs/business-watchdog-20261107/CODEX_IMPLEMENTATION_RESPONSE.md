# 主Codex实施复核回应

接受：启动订轨后尚无帧与prebuild等待盲点；受信metadata缺策略；普通池清理缺独立确认；倾听主候选必须分开接线。prebuild已加真实失败测试，先移入Owned pipeline任务，保证job事件/单调看门狗继续运行，不能只给一个局部await加超时后继续堵其他事件。

不采纳为共同定案的新增建议：
1. 缺策略自动使用300秒、观察到期自动转关闭，与已交付联合报告“未知配置先观察”不一致。300秒是候选客户端解析上界，不证明当前装机有效配置，更不代表授权将观察自然变成执行。最终上线必须有明确服务器保护策略和SN执行开关；在此之前只观察，不宣称故障收口。不能用永久观察作为最终交付。
2. Brain建议注册_sec与Android实际消费_ms不一致。现役生产config-store.ts SHA aa49c2b8已另取证，确无该键。要同一配置来源，必须保证快照按 voice.session_idle_timeout_ms 提供，或明确无歧义转换，不能双键漂移。服务端配置与客户端已应用状态必须区分。
3. 搜索“80秒轮询”不能覆盖resume grant可能300秒。接的是任务实际绝对截止，不能凭忙碌bool，也不能截断合法已授权恢复播报；需从实际SearchSession/后台协议对齐。
4. 连续新语音/新PCM属于实际进展，不凭“缺ASR final”给持续说话硬截时。静态VAD bool不得续命。
5. 单测中的30秒startup仅是注入测试参数，不是上线默认；guard的startup与启动参与者原60秒分层，最终配置需有来源。

证据：BRAIN_CONFIG_SOURCE.json；本机工作树business_watchdog.rs、pipeline.rs、job.rs；policy-red.log、audio-stats-red.log与prebuild-red-compiled（505通过1项正确失败）。prebuild首次测试编译因缺模块前缀失败，已修测试并得到正确行为失败，原日志保留。

下一步：完成实际guard接线、范围与策略校验、固定候选复审、全套与真实RTC对照，再发布。上述未决不阻止已有证据支持的基础实现。

署名：codex（OpenAI）| 2026-11-07 21:26 CST
